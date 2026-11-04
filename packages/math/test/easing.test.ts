import { describe, expect, it } from 'vitest';
import { easing } from '../src/index.ts';

/** Кривые, которые выходят за [0, 1] посередине. */
const overshooting = new Set([
  'backIn',
  'backOut',
  'backInOut',
  'elasticIn',
  'elasticOut',
  'elasticInOut',
]);
/** Отскок по определению не монотонен, но остаётся в [0, 1]. */
const bouncing = new Set(['bounceIn', 'bounceOut', 'bounceInOut']);

describe('easing: именованные кривые', () => {
  for (const [name, curve] of Object.entries(easing.named)) {
    it(`${name}: концы 0 и 1`, () => {
      expect(curve(0)).toBeCloseTo(0, 9);
      expect(curve(1)).toBeCloseTo(1, 9);
    });

    if (!overshooting.has(name)) {
      const monotonic = !bouncing.has(name);
      it(`${name}: не выходит за [0, 1]${monotonic ? ' и монотонна' : ''}`, () => {
        let previous = curve(0);
        for (let i = 1; i <= 200; i++) {
          const value = curve(i / 200);
          if (monotonic) expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
          expect(value).toBeGreaterThanOrEqual(-1e-12);
          expect(value).toBeLessThanOrEqual(1 + 1e-12);
          previous = value;
        }
      });
    }

    if (name.endsWith('InOut')) {
      it(`${name}: симметрична относительно середины`, () => {
        for (const t of [0.1, 0.25, 0.4]) {
          expect(curve(1 - t)).toBeCloseTo(1 - curve(t), 9);
        }
        expect(curve(0.5)).toBeCloseTo(0.5, 9);
      });
    }
  }

  it('Out-версия — отражение In-версии', () => {
    for (const base of ['quad', 'cubic', 'sine', 'expo', 'circ', 'back', 'elastic', 'bounce']) {
      const curveIn = easing.named[`${base}In` as easing.EasingName];
      const curveOut = easing.named[`${base}Out` as easing.EasingName];
      for (const t of [0.2, 0.5, 0.7]) {
        expect(curveOut(t), base).toBeCloseTo(1 - curveIn(1 - t), 9);
      }
    }
  });

  it('back и elastic выходят за пределы [0, 1]', () => {
    expect(easing.backIn(0.2)).toBeLessThan(0);
    expect(easing.backOut(0.8)).toBeGreaterThan(1);
    expect(easing.elasticOut(0.1)).toBeGreaterThan(1);
  });

  it('isEasingName', () => {
    expect(easing.isEasingName('cubicInOut')).toBe(true);
    expect(easing.isEasingName('toString')).toBe(false);
    expect(easing.isEasingName('cubic')).toBe(false);
  });
});

describe('easing: cubicBezier', () => {
  it('ease из CSS в опорных точках', () => {
    // Посчитано независимо: делением пополам по x(s) = t на параметрической кривой.
    expect(easing.cssEase(0.25)).toBeCloseTo(0.408511, 5);
    expect(easing.cssEase(0.5)).toBeCloseTo(0.802403, 5);
    expect(easing.cssEase(0.75)).toBeCloseTo(0.960459, 5);
  });

  it('совпадает с параметрической кривой', () => {
    const [x1, y1, x2, y2] = [0.68, -0.55, 0.27, 1.55];
    const curve = easing.cubicBezier(x1, y1, x2, y2);
    for (let i = 1; i < 20; i++) {
      const s = i / 20;
      const x = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3;
      const y = 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3;
      expect(curve(x)).toBeCloseTo(y, 5);
    }
  });

  it('прямая линия — это linear', () => {
    expect(easing.cubicBezier(0.3, 0.3, 0.7, 0.7)).toBe(easing.linear);
  });

  it('крутые участки решаются без расхождения', () => {
    const curve = easing.cubicBezier(1, 0, 0, 1);
    let previous = 0;
    for (let i = 0; i <= 1000; i++) {
      const value = curve(i / 1000);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = value;
    }
  });

  it('время вне [0, 1] обрезается', () => {
    expect(easing.cssEase(-1)).toBe(0);
    expect(easing.cssEase(2)).toBe(1);
  });

  it('x вне [0, 1] — ошибка', () => {
    expect(() => easing.cubicBezier(-0.1, 0, 0.5, 1)).toThrow(RangeError);
    expect(() => easing.cubicBezier(0.5, 0, 1.1, 1)).toThrow(RangeError);
    expect(() => easing.cubicBezier(Number.NaN, 0, 0.5, 1)).toThrow(RangeError);
  });
});

describe('easing: steps', () => {
  it('end (по умолчанию)', () => {
    const curve = easing.steps(4);
    expect([0, 0.24, 0.25, 0.5, 0.99, 1].map(curve)).toEqual([0, 0, 0.25, 0.5, 0.75, 1]);
  });

  it('start', () => {
    const curve = easing.steps(4, 'start');
    expect([0, 0.01, 0.25, 0.75, 1].map(curve)).toEqual([0.25, 0.25, 0.5, 1, 1]);
  });

  it('both', () => {
    const curve = easing.steps(3, 'both');
    expect([0, 0.34, 0.99, 1].map(curve)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('none', () => {
    const curve = easing.steps(5, 'none');
    expect([0, 0.2, 0.5, 0.99, 1].map(curve)).toEqual([0, 0.25, 0.5, 1, 1]);
  });

  it('время вне [0, 1] обрезается', () => {
    const curve = easing.steps(4);
    expect(curve(-1)).toBe(0);
    expect(curve(2)).toBe(1);
  });

  it('недопустимое число ступенек — ошибка', () => {
    expect(() => easing.steps(0)).toThrow(RangeError);
    expect(() => easing.steps(2.5)).toThrow(RangeError);
    expect(() => easing.steps(1, 'none')).toThrow(RangeError);
  });
});
