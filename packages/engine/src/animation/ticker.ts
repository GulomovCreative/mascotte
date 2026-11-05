/*
 * Ticker is the shared frame loop. The core knows nothing about the DOM: frames are requested by a
 * pluggable scheduler, and tab visibility, `prefers-reduced-motion` and element visibility are
 * reported by outside code (in the browser, `@mascotte/player`) through pauses with reasons.
 */

/**
 * Frame handler: `dt` is seconds since the ticker's previous frame (at most `maxDelta`),
 * `time` is the subscription time: the sum of the `dt` values it received.
 */
export type TickCallback = (dt: number, time: number) => void;

/** What requests the next frame. In the browser, `requestAnimationFrame`. */
export interface FrameScheduler {
  /** Asks to call `callback` on the next frame with the current time in milliseconds. */
  request(callback: (now: number) => void): unknown;
  /** Cancels the request returned by `request`. */
  cancel(handle: unknown): void;
}

export interface TickerOptions {
  /** Largest `dt` in seconds: time does not jump after a stall. Defaults to 0.1. */
  maxDelta?: number;
  /** Frame scheduler. Defaults to `requestAnimationFrame`, or a 60 Hz timer without it. */
  scheduler?: FrameScheduler;
}

/** Frame subscription: its own pauses (for example, "offscreen") and its own time. */
export interface TickSubscription {
  /** Subscription time in seconds: the sum of all `dt` values it received. */
  readonly time: number;
  /** Whether the subscription is paused for any reason. */
  readonly paused: boolean;
  pause(reason: string): void;
  resume(reason: string): void;
  /** Unsubscribes. A repeated call does nothing. */
  remove(): void;
}

/** Default scheduler: `requestAnimationFrame`, or a 60 Hz timer where it is missing. */
export function defaultScheduler(): FrameScheduler {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === 'function') {
    return {
      request: (callback) => raf.call(globalThis, callback),
      cancel: (handle) => globalThis.cancelAnimationFrame(handle as number),
    };
  }
  return {
    request: (callback) => setTimeout(() => callback(performance.now()), 1000 / 60),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

class Subscription implements TickSubscription {
  time = 0;
  readonly reasons = new Set<string>();
  removed = false;

  readonly ticker: Ticker;
  readonly callback: TickCallback;

  constructor(ticker: Ticker, callback: TickCallback) {
    this.ticker = ticker;
    this.callback = callback;
  }

  get paused(): boolean {
    return this.reasons.size > 0;
  }

  pause(reason: string): void {
    if (this.removed || this.reasons.has(reason)) return;
    this.reasons.add(reason);
    tickerInternals.changed(this.ticker);
  }

  resume(reason: string): void {
    if (this.removed || !this.reasons.delete(reason)) return;
    tickerInternals.changed(this.ticker);
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    tickerInternals.remove(this.ticker, this);
  }
}

let tickerInternals!: {
  changed(ticker: Ticker): void;
  remove(ticker: Ticker, subscription: Subscription): void;
};

let shared: Ticker | null = null;

/**
 * Shared frame loop. Subscriptions receive `dt` in seconds, capped at `maxDelta`. Frames are
 * requested only while there is an active subscription and the ticker is not paused: at rest the
 * loop does not spin. After a pause the first frame does not receive the time spent paused.
 *
 * Pauses are set by reasons so that different sources do not interfere: for example, `'hidden'`
 * (the tab is hidden) and `'reduced-motion'`. The ticker runs when there are no reasons.
 */
export class Ticker {
  /** Shared ticker per page: one frame loop for all mascots. */
  static get shared(): Ticker {
    shared ??= new Ticker();
    return shared;
  }

  readonly maxDelta: number;
  readonly #scheduler: FrameScheduler;
  readonly #subscriptions: Subscription[] = [];
  readonly #reasons = new Set<string>();
  #handle: unknown = null;
  #last: number | null = null;
  #ticking = false;
  #hasRemoved = false;
  #frame = (now: number) => this.tick(now);

  constructor(options: TickerOptions = {}) {
    const maxDelta = options.maxDelta ?? 0.1;
    if (!(maxDelta > 0 && Number.isFinite(maxDelta))) {
      throw new RangeError(`maxDelta must be positive, got ${maxDelta}.`);
    }
    this.maxDelta = maxDelta;
    this.#scheduler = options.scheduler ?? defaultScheduler();
  }

  /** Whether the ticker is paused for any reason. */
  get paused(): boolean {
    return this.#reasons.size > 0;
  }

  /** Whether the ticker is requesting frames now. */
  get running(): boolean {
    return this.#handle !== null;
  }

  /** Subscribes `callback` to frames. */
  add(callback: TickCallback): TickSubscription {
    const subscription = new Subscription(this, callback);
    this.#subscriptions.push(subscription);
    if (!this.#ticking) this.#update();
    return subscription;
  }

  pause(reason: string): void {
    if (this.#reasons.has(reason)) return;
    this.#reasons.add(reason);
    if (!this.#ticking) this.#update();
  }

  resume(reason: string): void {
    if (!this.#reasons.delete(reason)) return;
    if (!this.#ticking) this.#update();
  }

  /**
   * A frame at time `now` (milliseconds). Usually the scheduler calls it, but it can also be called
   * manually, in tests or with a custom loop. The first frame after start or pause sets the
   * reference point and gives `dt = 0`. Pausing one subscription while others run does not reset
   * the reference: its first frame after the pause and the first frame of a new subscription
   * receive the regular frame `dt`, and the paused time does not get into it. A call from a frame
   * handler does nothing. If handlers throw, the rest still receive the frame, and the first error
   * is rethrown after it.
   */
  tick(now: number): void {
    // A frame from inside a frame handler does nothing: otherwise the outer frame would run
    // unprotected.
    if (this.#ticking) return;
    // A manual call while a request is pending: otherwise there would be two requests.
    if (this.#handle !== null) this.#scheduler.cancel(this.#handle);
    this.#handle = null;
    if (!this.#active()) {
      this.#last = null;
      return;
    }
    const last = this.#last;
    this.#last = now;
    const dt = last === null ? 0 : Math.min(Math.max(0, (now - last) / 1000), this.maxDelta);
    // Subscriptions added during a frame receive frames from the next one; ones removed during a
    // frame no longer receive them. The list is not copied: removed ones are purged afterwards.
    const list = this.#subscriptions;
    const count = list.length;
    // An error in one handler does not affect the others: the first is rethrown after the frame.
    let failed = false;
    let error: unknown;
    this.#ticking = true;
    for (let i = 0; i < count; i++) {
      const subscription = list[i] as Subscription;
      if (subscription.removed || subscription.paused) continue;
      subscription.time += dt;
      try {
        subscription.callback(dt, subscription.time);
      } catch (caught) {
        if (!failed) {
          failed = true;
          error = caught;
        }
      }
    }
    this.#ticking = false;
    if (this.#hasRemoved) this.#compact();
    this.#update();
    if (failed) throw error;
  }

  #compact(): void {
    const list = this.#subscriptions;
    let kept = 0;
    for (let i = 0; i < list.length; i++) {
      const subscription = list[i] as Subscription;
      if (!subscription.removed) list[kept++] = subscription;
    }
    list.length = kept;
    this.#hasRemoved = false;
  }

  /** Whether there is anyone to deliver frames to. */
  #active(): boolean {
    if (this.paused) return false;
    const list = this.#subscriptions;
    for (let i = 0; i < list.length; i++) {
      const subscription = list[i] as Subscription;
      if (!subscription.removed && !subscription.paused) return true;
    }
    return false;
  }

  /** Requests a frame if one is needed, or cancels the request if not. */
  #update(): void {
    const active = this.#active();
    if (active && this.#handle === null) {
      this.#handle = this.#scheduler.request(this.#frame);
    } else if (!active) {
      if (this.#handle !== null) this.#scheduler.cancel(this.#handle);
      this.#handle = null;
      // Reference from zero after a pause: the paused time will not get into dt.
      this.#last = null;
    }
  }

  static {
    tickerInternals = {
      changed: (ticker) => {
        if (!ticker.#ticking) ticker.#update();
      },
      remove: (ticker, subscription) => {
        // The list is not touched during a frame: the subscription is already marked removed.
        if (ticker.#ticking) ticker.#hasRemoved = true;
        else {
          const list = ticker.#subscriptions;
          const index = list.indexOf(subscription);
          if (index >= 0) list.splice(index, 1);
        }
        // Inside a frame, requesting the next one is decided at the end of the frame.
        if (!ticker.#ticking) ticker.#update();
      },
    };
  }
}
