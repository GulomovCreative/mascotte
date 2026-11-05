import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultScheduler,
  type FrameScheduler,
  Ticker,
  type TickSubscription,
} from '../src/index.ts';

/** A scheduler that delivers frames on `frame(now)`. */
function manualScheduler() {
  let next = 1;
  const pending = new Map<number, (now: number) => void>();
  const scheduler: FrameScheduler = {
    request(callback) {
      const handle = next++;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    scheduler,
    get pending() {
      return pending.size;
    },
    /** Frame at `now` (ms): calls everything requested before it. */
    frame(now: number) {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(now);
    },
  };
}

describe('Ticker', () => {
  it('gives dt in seconds and accumulates subscription time; the first frame is zero', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    const calls: [number, number][] = [];
    ticker.add((dt, time) => calls.push([dt, time]));
    expect(ticker.running).toBe(true);
    clock.frame(1000);
    clock.frame(1016);
    clock.frame(1050);
    expect(calls.map(([dt]) => Math.round(dt * 1000))).toEqual([0, 16, 34]);
    expect(calls.at(-1)?.[1]).toBeCloseTo(0.05, 9);
  });

  it('a large jump is capped by maxDelta, time going backwards gives zero', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler, maxDelta: 0.05 });
    const dts: number[] = [];
    ticker.add((dt) => dts.push(dt));
    clock.frame(0);
    clock.frame(5000);
    clock.frame(4000);
    expect(dts).toEqual([0, 0.05, 0]);
    expect(() => new Ticker({ maxDelta: 0 })).toThrow(RangeError);
  });

  it('no frames are requested when idle: no subscriptions, paused, all subscriptions paused', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    expect(ticker.running).toBe(false);
    const subscription = ticker.add(() => {});
    expect(clock.pending).toBe(1);
    ticker.pause('hidden');
    expect([ticker.running, clock.pending]).toEqual([false, 0]);
    ticker.resume('hidden');
    expect(clock.pending).toBe(1);
    subscription.pause('offscreen');
    expect([ticker.running, clock.pending]).toEqual([false, 0]);
    subscription.resume('offscreen');
    expect(clock.pending).toBe(1);
    subscription.remove();
    expect([ticker.running, clock.pending]).toEqual([false, 0]);
  });

  it('pauses for different reasons do not interfere', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    ticker.add(() => {});
    ticker.pause('hidden');
    ticker.pause('reduced-motion');
    ticker.resume('hidden');
    expect(ticker.paused).toBe(true);
    // Releasing the same reason again changes nothing.
    ticker.resume('hidden');
    expect(ticker.paused).toBe(true);
    ticker.resume('reduced-motion');
    expect([ticker.paused, ticker.running]).toEqual([false, true]);
  });

  it('paused time is not included in dt', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler, maxDelta: 10 });
    const dts: number[] = [];
    ticker.add((dt) => dts.push(dt));
    clock.frame(0);
    clock.frame(16);
    ticker.pause('hidden');
    ticker.resume('hidden');
    clock.frame(5000);
    clock.frame(5016);
    expect(dts.map((dt) => Math.round(dt * 1000))).toEqual([0, 16, 0, 16]);
  });

  it('a paused subscription gets no frames and accumulates no time, the others run', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    const a: number[] = [];
    const b: number[] = [];
    const first = ticker.add((_dt, time) => a.push(time));
    ticker.add((_dt, time) => b.push(time));
    clock.frame(0);
    clock.frame(10);
    first.pause('offscreen');
    expect(first.paused).toBe(true);
    clock.frame(20);
    first.resume('offscreen');
    clock.frame(30);
    expect(a.map((t) => Math.round(t * 1000))).toEqual([0, 10, 20]);
    expect(b.map((t) => Math.round(t * 1000))).toEqual([0, 10, 20, 30]);
    expect(first.time).toBeCloseTo(0.02, 9);
  });

  it('subscriptions added and removed during a frame take effect correctly', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    const order: string[] = [];
    let late = null as TickSubscription | null;
    const self = ticker.add(() => {
      order.push('self');
      // Removes itself and a neighbor, adds a new subscription.
      self.remove();
      other.remove();
      late = ticker.add(() => order.push('late'));
    });
    const other = ticker.add(() => order.push('other'));
    clock.frame(0);
    expect(order).toEqual(['self']);
    clock.frame(16);
    expect(order).toEqual(['self', 'late']);
    late?.remove();
    late?.remove();
    expect(ticker.running).toBe(false);
  });

  it('an error in a subscription does not stop the loop for good', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    let calls = 0;
    ticker.add(() => {
      calls++;
      if (calls === 1) throw new Error('failure');
    });
    expect(() => clock.frame(0)).toThrow('failure');
    expect(ticker.running).toBe(true);
    clock.frame(16);
    expect(calls).toBe(2);
  });

  it('a manual frame with a pending request does not double requests', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    ticker.add(() => {});
    expect(clock.pending).toBe(1);
    ticker.tick(0);
    expect(clock.pending).toBe(1);
  });

  it('there is one shared ticker per page', () => {
    expect(Ticker.shared).toBe(Ticker.shared);
  });

  it('an error in one callback does not stop the others from getting the frame', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    const seen: string[] = [];
    ticker.add(() => {
      seen.push('a');
      throw new Error('first');
    });
    ticker.add(() => {
      seen.push('b');
      throw new Error('second');
    });
    ticker.add(() => seen.push('c'));
    expect(() => clock.frame(0)).toThrow('first');
    expect(seen).toEqual(['a', 'b', 'c']);
    // Timing is not reset: the next frame gets a normal dt.
    const dts: number[] = [];
    ticker.add((dt) => dts.push(dt));
    expect(() => clock.frame(16)).toThrow('first');
    expect(dts.map((dt) => Math.round(dt * 1000))).toEqual([16]);
  });

  it('a frame from inside a callback does nothing', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    const seen: string[] = [];
    ticker.add(() => {
      seen.push('a');
      ticker.tick(100);
    });
    const b = ticker.add(() => {
      seen.push('b');
      b.remove();
    });
    ticker.add(() => seen.push('c'));
    clock.frame(0);
    expect(seen).toEqual(['a', 'b', 'c']);
    clock.frame(16);
    expect(seen).toEqual(['a', 'b', 'c', 'a', 'c']);
  });

  it('pausing from a callback stops frame requests, resuming restarts them', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    let calls = 0;
    ticker.add(() => {
      calls++;
      ticker.pause('user');
    });
    clock.frame(0);
    expect([calls, ticker.running, clock.pending]).toEqual([1, false, 0]);
    ticker.resume('user');
    expect(clock.pending).toBe(1);
  });

  it('dt is shared by the ticker: new and resumed subscriptions get the frame dt', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler, maxDelta: 10 });
    ticker.add(() => {});
    const paused = ticker.add(() => {});
    clock.frame(0);
    clock.frame(16);
    paused.pause('offscreen');
    clock.frame(1000);
    paused.resume('offscreen');
    const late: number[] = [];
    ticker.add((dt) => late.push(dt));
    clock.frame(1016);
    // The subscription did not get the paused time, the new subscription got the normal frame dt.
    expect(Math.round(paused.time * 1000)).toBe(32);
    expect(late.map((dt) => Math.round(dt * 1000))).toEqual([16]);
  });
});

describe('defaultScheduler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses requestAnimationFrame when available', () => {
    const request = vi.fn(() => 7);
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const scheduler = defaultScheduler();
    const callback = () => {};
    expect(scheduler.request(callback)).toBe(7);
    expect(request).toHaveBeenCalledWith(callback);
    scheduler.cancel(7);
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('without requestAnimationFrame a 60 Hz timer with millisecond time', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.useFakeTimers();
    const scheduler = defaultScheduler();
    const times: number[] = [];
    scheduler.request((now) => times.push(now));
    const cancelled = scheduler.request((now) => times.push(-now));
    scheduler.cancel(cancelled);
    vi.advanceTimersByTime(20);
    expect(times).toHaveLength(1);
    expect(times[0]).toBeGreaterThanOrEqual(0);
  });
});
