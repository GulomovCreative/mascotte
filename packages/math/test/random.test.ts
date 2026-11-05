import { describe, expect, it } from 'vitest';
import { random } from '../src/index.ts';

describe('random.hash', () => {
  it('is deterministic, in [0, 1) and spreads neighboring indices and seeds', () => {
    expect(random.hash(7, 3)).toBe(random.hash(7, 3));
    const values: number[] = [];
    for (let seed = 0; seed < 4; seed++) {
      for (let i = -500; i < 500; i++) values.push(random.hash(seed, i));
    }
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    // Roughly uniform: every tenth of the range gets close to a tenth of the values.
    const bins = new Array(10).fill(0);
    for (const v of values) bins[Math.floor(v * 10)]++;
    for (const count of bins) expect(Math.abs(count - values.length / 10)).toBeLessThan(80);
    expect(random.hash(1, 0)).not.toBe(random.hash(2, 0));
    expect(random.hash(1, 0)).not.toBe(random.hash(1, 1));
    // The seed is taken as 32 bits.
    expect(random.hash(-1, 5)).toBe(random.hash(0xffffffff, 5));
  });

  it('isSeed accepts 32-bit integers', () => {
    expect([0, -1, 42, 0xffffffff, -0x80000000].every(random.isSeed)).toBe(true);
    expect([0.5, Number.NaN, Infinity, 2 ** 32, -(2 ** 31) - 1].some(random.isSeed)).toBe(false);
  });
});

describe('random.noise', () => {
  it('is 0 at integers, bounded, deterministic and continuous', () => {
    for (let i = -5; i <= 5; i++) expect(random.noise(3, i) === 0).toBe(true);
    let previous = random.noise(3, -5);
    let max = 0;
    for (let x = -5; x <= 5; x += 0.001) {
      const value = random.noise(3, x);
      expect(Math.abs(value)).toBeLessThanOrEqual(0.5);
      // A step of 0.001 never jumps: the slope is bounded.
      expect(Math.abs(value - previous)).toBeLessThan(0.01);
      max = Math.max(max, Math.abs(value));
      previous = value;
    }
    expect(max).toBeGreaterThan(0.1);
    expect(random.noise(3, 1.37)).toBe(random.noise(3, 1.37));
    expect(random.noise(3, 1.37)).not.toBe(random.noise(4, 1.37));
  });

  it('has a continuous slope at integers and uses most of its range', () => {
    const h = 1e-5;
    for (let i = -5; i <= 5; i++) {
      const left = (random.noise(3, i) - random.noise(3, i - h)) / h;
      const right = (random.noise(3, i + h) - random.noise(3, i)) / h;
      expect(Math.abs(left - right)).toBeLessThan(1e-3);
    }
    let max = 0;
    for (let x = 0; x < 200; x += 0.01) max = Math.max(max, Math.abs(random.noise(5, x)));
    expect(max).toBeGreaterThan(0.4);
  });
});
