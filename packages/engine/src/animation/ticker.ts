/*
 * Ticker — общий цикл кадров. Ядро не знает про DOM: кадры просит подставляемый
 * планировщик, а видимость вкладки, `prefers-reduced-motion` и видимость элементов
 * сообщает внешний код (в браузере — `@mascotte/player`) через паузы с причинами.
 */

/**
 * Обработчик кадра: `dt` — секунды с прошлого кадра тикера (не больше `maxDelta`),
 * `time` — время подписки: сумма полученных ею `dt`.
 */
export type TickCallback = (dt: number, time: number) => void;

/** Кто просит следующий кадр. В браузере — `requestAnimationFrame`. */
export interface FrameScheduler {
  /** Просит вызвать `callback` в следующем кадре с текущим временем в миллисекундах. */
  request(callback: (now: number) => void): unknown;
  /** Отменяет запрос, который вернул `request`. */
  cancel(handle: unknown): void;
}

export interface TickerOptions {
  /** Наибольший `dt` в секундах: после подвисания время не прыгает. По умолчанию 0,1. */
  maxDelta?: number;
  /** Планировщик кадров. По умолчанию `requestAnimationFrame`, а без него — таймер на 60 Гц. */
  scheduler?: FrameScheduler;
}

/** Подписка на кадры: свои паузы (например, «вне экрана») и своё время. */
export interface TickSubscription {
  /** Время подписки в секундах: сумма всех `dt`, которые она получила. */
  readonly time: number;
  /** Стоит ли подписка на паузе по какой-нибудь причине. */
  readonly paused: boolean;
  pause(reason: string): void;
  resume(reason: string): void;
  /** Отписывает. Повторный вызов ничего не делает. */
  remove(): void;
}

/** Планировщик по умолчанию: `requestAnimationFrame`, а где его нет — таймер на 60 Гц. */
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
 * Общий цикл кадров. Подписки получают `dt` в секундах, ограниченный `maxDelta`.
 * Кадры просятся только пока есть активная подписка и тикер не на паузе: в покое цикл
 * не крутится. После паузы первый кадр не получает время, проведённое на паузе.
 *
 * Паузы задаются причинами, чтобы разные источники не мешали друг другу: например,
 * `'hidden'` (вкладка скрыта) и `'reduced-motion'`. Тикер идёт, когда причин нет.
 */
export class Ticker {
  /** Общий тикер на страницу: один цикл кадров для всех маскотов. */
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
      throw new RangeError(`maxDelta должен быть положительным, получено ${maxDelta}.`);
    }
    this.maxDelta = maxDelta;
    this.#scheduler = options.scheduler ?? defaultScheduler();
  }

  /** Стоит ли тикер на паузе по какой-нибудь причине. */
  get paused(): boolean {
    return this.#reasons.size > 0;
  }

  /** Просит ли тикер кадры сейчас. */
  get running(): boolean {
    return this.#handle !== null;
  }

  /** Подписывает `callback` на кадры. */
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
   * Кадр в момент `now` (миллисекунды). Обычно его вызывает планировщик, но можно
   * и вручную — в тестах или со своим циклом. Первый кадр после запуска или паузы
   * задаёт отсчёт и даёт `dt = 0`. Пауза одной подписки, пока другие идут, отсчёт не
   * сбрасывает: её первый кадр после паузы и первый кадр новой подписки получают
   * обычный `dt` кадра, а время паузы в него не попадает. Вызов из обработчика кадра
   * ничего не делает. Если обработчики бросили ошибки, остальные всё равно получают
   * кадр, а первая ошибка выбрасывается после него.
   */
  tick(now: number): void {
    // Кадр из обработчика кадра ничего не делает: иначе внешний кадр шёл бы без защиты.
    if (this.#ticking) return;
    // Вызов вручную при ждущем запросе: иначе запросов стало бы два.
    if (this.#handle !== null) this.#scheduler.cancel(this.#handle);
    this.#handle = null;
    if (!this.#active()) {
      this.#last = null;
      return;
    }
    const last = this.#last;
    this.#last = now;
    const dt = last === null ? 0 : Math.min(Math.max(0, (now - last) / 1000), this.maxDelta);
    // Подписки, добавленные во время кадра, получат кадры со следующего; удалённые
    // во время кадра уже не получат. Список не копируется: удалённые вычищаются после.
    const list = this.#subscriptions;
    const count = list.length;
    // Ошибка одного обработчика не мешает остальным: первая выбрасывается после кадра.
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

  /** Есть ли кому отдавать кадры. */
  #active(): boolean {
    if (this.paused) return false;
    const list = this.#subscriptions;
    for (let i = 0; i < list.length; i++) {
      const subscription = list[i] as Subscription;
      if (!subscription.removed && !subscription.paused) return true;
    }
    return false;
  }

  /** Просит кадр, если он нужен, или отменяет запрос, если нет. */
  #update(): void {
    const active = this.#active();
    if (active && this.#handle === null) {
      this.#handle = this.#scheduler.request(this.#frame);
    } else if (!active) {
      if (this.#handle !== null) this.#scheduler.cancel(this.#handle);
      this.#handle = null;
      // Отсчёт с нуля после паузы: время паузы не попадёт в dt.
      this.#last = null;
    }
  }

  static {
    tickerInternals = {
      changed: (ticker) => {
        if (!ticker.#ticking) ticker.#update();
      },
      remove: (ticker, subscription) => {
        // Во время кадра список не трогается: подписка уже помечена удалённой.
        if (ticker.#ticking) ticker.#hasRemoved = true;
        else {
          const list = ticker.#subscriptions;
          const index = list.indexOf(subscription);
          if (index >= 0) list.splice(index, 1);
        }
        // Внутри кадра запрос следующего решится в конце кадра.
        if (!ticker.#ticking) ticker.#update();
      },
    };
  }
}
