import { describe, expect, it } from 'vitest';
import { easing } from '../src/index.ts';

/** Curves that leave [0, 1] in the middle. */
const overshooting = new Set([
  'backIn',
  'backOut',
  'backInOut',
  'elasticIn',
  'elasticOut',
  'elasticInOut',
]);
/** Bounce is not monotonic by definition but stays within [0, 1]. */
const bouncing = new Set(['bounceIn', 'bounceOut', 'bounceInOut']);

describe('easing: named curves', () => {
  for (const [name, curve] of Object.entries(easing.named)) {
    it(`${name}: exactly 0 and 1 at the ends`, () => {
      expect(curve(0)).toBe(0);
      expect(curve(1)).toBe(1);
    });

    if (!overshooting.has(name)) {
      const monotonic = !bouncing.has(name);
      it(`${name}: stays within [0, 1]${monotonic ? ' and is monotonic' : ''}`, () => {
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
      it(`${name}: symmetric about the midpoint`, () => {
        for (const t of [0.1, 0.25, 0.4]) {
          expect(curve(1 - t)).toBeCloseTo(1 - curve(t), 9);
        }
        expect(curve(0.5)).toBeCloseTo(0.5, 9);
      });
    }
  }

  it('values at reference points match the standard formulas', () => {
    // Computed by hand from the curve formulas, not through the implementation.
    const expected: [easing.EasingName, number, number][] = [
      ['quadIn', 0.3, 0.09],
      ['quadOut', 0.3, 0.51],
      ['cubicIn', 0.5, 0.125],
      ['quartIn', 0.5, 0.0625],
      ['quintIn', 0.5, 0.03125],
      ['sineIn', 0.5, 1 - Math.SQRT1_2],
      ['expoIn', 0.5, 0.03125],
      ['circIn', 0.5, 1 - Math.sqrt(0.75)],
      ['backIn', 0.5, -0.0876975],
      ['elasticIn', 0.5, -0.015625],
      ['elasticOut', 0.5, 1.015625],
      ['bounceOut', 0.2, 0.3025],
      ['bounceOut', 0.5, 0.765625],
      ['bounceOut', 0.8, 0.94],
      ['bounceOut', 0.95, 0.98453125],
      ['cubicInOut', 0.25, 0.0625],
      ['quadInOut', 0.75, 0.875],
    ];
    for (const [name, t, value] of expected) {
      expect(easing.named[name](t), `${name}(${t})`).toBeCloseTo(value, 9);
    }
  });

  it('back and elastic leave [0, 1]', () => {
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
  it('CSS ease at reference points', () => {
    // Computed independently: bisection on x(s) = t along the parametric curve.
    expect(easing.cssEase(0.25)).toBeCloseTo(0.408511, 5);
    expect(easing.cssEase(0.5)).toBeCloseTo(0.802403, 5);
    expect(easing.cssEase(0.75)).toBeCloseTo(0.960459, 5);
  });

  it('matches the parametric curve', () => {
    const [x1, y1, x2, y2] = [0.68, -0.55, 0.27, 1.55];
    const curve = easing.cubicBezier(x1, y1, x2, y2);
    for (let i = 1; i < 20; i++) {
      const s = i / 20;
      const x = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3;
      const y = 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3;
      expect(curve(x)).toBeCloseTo(y, 5);
    }
  });

  it('a straight line is linear', () => {
    expect(easing.cubicBezier(0.3, 0.3, 0.7, 0.7)).toBe(easing.linear);
  });

  it('steep sections are solved without divergence', () => {
    const curve = easing.cubicBezier(1, 0, 0, 1);
    let previous = 0;
    for (let i = 0; i <= 1000; i++) {
      const value = curve(i / 1000);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = value;
    }
  });

  it('time outside [0, 1] is clamped', () => {
    expect(easing.cssEase(-1)).toBe(0);
    expect(easing.cssEase(2)).toBe(1);
  });

  it('x outside [0, 1] and non-finite y are errors', () => {
    expect(() => easing.cubicBezier(-0.1, 0, 0.5, 1)).toThrow(RangeError);
    expect(() => easing.cubicBezier(0.5, 0, 1.1, 1)).toThrow(RangeError);
    expect(() => easing.cubicBezier(Number.NaN, 0, 0.5, 1)).toThrow(RangeError);
    expect(() => easing.cubicBezier(0.5, Number.NaN, 0.5, 1)).toThrow(RangeError);
    expect(() => easing.cubicBezier(0.5, 0, 0.5, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('y outside [0, 1] gives undershoot and overshoot', () => {
    const curve = easing.cubicBezier(0.5, -1, 0.5, 2);
    const values = Array.from({ length: 101 }, (_, i) => curve(i / 100));
    expect(Math.min(...values)).toBeLessThan(0);
    expect(Math.max(...values)).toBeGreaterThan(1);
    expect(curve(0)).toBe(0);
    expect(curve(1)).toBe(1);
  });
});

describe('easing: steps', () => {
  it('end (default)', () => {
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
    expect(curve(1 / 3 + 1e-12)).toBe(0.5);
    expect(curve(2 / 3 + 1e-12)).toBe(0.75);
  });

  it('none', () => {
    const curve = easing.steps(5, 'none');
    expect([0, 0.2, 0.5, 0.99, 1].map(curve)).toEqual([0, 0.25, 0.5, 1, 1]);
    const three = easing.steps(3, 'none');
    expect([0, 0.34, 0.67, 1].map(three)).toEqual([0, 0.5, 1, 1]);
  });

  it('a single step', () => {
    const curve = easing.steps(1);
    expect([0, 0.5, 0.999, 1].map(curve)).toEqual([0, 0, 0, 1]);
  });

  it('time outside [0, 1] is clamped', () => {
    const curve = easing.steps(4);
    expect(curve(-1)).toBe(0);
    expect(curve(2)).toBe(1);
  });

  it('an invalid step count is an error', () => {
    expect(() => easing.steps(0)).toThrow(RangeError);
    expect(() => easing.steps(2.5)).toThrow(RangeError);
    expect(() => easing.steps(1, 'none')).toThrow(RangeError);
  });
});

describe('easing: resolve', () => {
  it('curve name', () => {
    expect(easing.resolve('backOut')).toBe(easing.backOut);
    expect(() => easing.resolve('wobble' as easing.EasingName)).toThrow(RangeError);
  });

  it('cubicBezier and steps from parameters', () => {
    const curve = easing.resolve({ type: 'cubicBezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 });
    expect(curve(0.5)).toBeCloseTo(easing.cssEase(0.5), 12);
    expect(easing.resolve({ type: 'steps', count: 4 })(0.5)).toBe(0.5);
    expect(easing.resolve({ type: 'steps', count: 4, position: 'start' })(0)).toBe(0.25);
  });

  it('invalid parameters and type are errors', () => {
    expect(() => easing.resolve({ type: 'cubicBezier', x1: 2, y1: 0, x2: 0, y2: 1 })).toThrow(
      RangeError,
    );
    expect(() => easing.resolve({ type: 'steps', count: 0 })).toThrow(RangeError);
    expect(() => easing.resolve({ type: 'spring' } as unknown as easing.EasingSpec)).toThrow(
      RangeError,
    );
  });
});
