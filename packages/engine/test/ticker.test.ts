import { describe, expect, it } from 'vitest';
import { type FrameScheduler, Ticker, type TickSubscription } from '../src/index.ts';

/** Планировщик, который отдаёт кадры по команде `frame(now)`. */
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
    /** Кадр в момент `now` (мс): вызывает всё, что было запрошено до него. */
    frame(now: number) {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(now);
    },
  };
}

describe('Ticker', () => {
  it('отдаёт dt в секундах и копит время подписки; первый кадр — нулевой', () => {
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

  it('большой скачок ограничен maxDelta, время назад даёт ноль', () => {
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

  it('в покое кадры не просятся: без подписок, на паузе, при паузе всех подписок', () => {
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

  it('паузы по разным причинам не мешают друг другу', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    ticker.add(() => {});
    ticker.pause('hidden');
    ticker.pause('reduced-motion');
    ticker.resume('hidden');
    expect(ticker.paused).toBe(true);
    // Повторное снятие той же причины ничего не меняет.
    ticker.resume('hidden');
    expect(ticker.paused).toBe(true);
    ticker.resume('reduced-motion');
    expect([ticker.paused, ticker.running]).toEqual([false, true]);
  });

  it('время паузы не попадает в dt', () => {
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

  it('подписка на паузе не получает кадров и не копит время, остальные идут', () => {
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

  it('подписки, добавленные и удалённые во время кадра, вступают в силу корректно', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    const order: string[] = [];
    let late = null as TickSubscription | null;
    const self = ticker.add(() => {
      order.push('self');
      // Удаляет себя и соседа, добавляет новую подписку.
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

  it('ошибка в подписке не останавливает цикл навсегда', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    let calls = 0;
    ticker.add(() => {
      calls++;
      if (calls === 1) throw new Error('сбой');
    });
    expect(() => clock.frame(0)).toThrow('сбой');
    expect(ticker.running).toBe(true);
    clock.frame(16);
    expect(calls).toBe(2);
  });

  it('ручной кадр при ждущем запросе не удваивает запросы', () => {
    const clock = manualScheduler();
    const ticker = new Ticker({ scheduler: clock.scheduler });
    ticker.add(() => {});
    expect(clock.pending).toBe(1);
    ticker.tick(0);
    expect(clock.pending).toBe(1);
  });

  it('общий тикер один на страницу', () => {
    expect(Ticker.shared).toBe(Ticker.shared);
  });
});
