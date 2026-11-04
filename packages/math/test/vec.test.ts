import { describe, expect, it } from 'vitest';
import { approxEqual, clamp, lerp, vec2, vec3 } from '../src/index.ts';
import { expectClose } from './helpers.ts';

describe('common', () => {
  it('approxEqual учитывает масштаб чисел', () => {
    expect(approxEqual(1, 1 + 1e-7)).toBe(true);
    expect(approxEqual(1, 1.001)).toBe(false);
    expect(approxEqual(1e9, 1e9 + 10)).toBe(true);
  });

  it('clamp и lerp', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(lerp(2, 4, 0.25)).toBe(2.5);
  });
});

describe('vec2', () => {
  it('арифметика', () => {
    const a = vec2.create(1, 2);
    const b = vec2.create(3, -1);
    expect(vec2.add(vec2.create(), a, b)).toEqual({ x: 4, y: 1 });
    expect(vec2.sub(vec2.create(), a, b)).toEqual({ x: -2, y: 3 });
    expect(vec2.scaleAndAdd(vec2.create(), a, b, 2)).toEqual({ x: 7, y: 0 });
    expect(vec2.dot(a, b)).toBe(1);
    expect(vec2.cross(vec2.create(1, 0), vec2.create(0, 1))).toBe(1);
    expect(vec2.distance(a, b)).toBeCloseTo(Math.hypot(2, 3));
  });

  it('rotate поворачивает от X к Y', () => {
    expectClose(vec2.rotate(vec2.create(), vec2.create(1, 0), Math.PI / 2), { x: 0, y: 1 });
  });

  it('out может совпадать с аргументом', () => {
    const a = vec2.create(1, 2);
    expect(vec2.add(a, a, a)).toBe(a);
    expect(a).toEqual({ x: 2, y: 4 });
  });

  it('нулевой вектор нормируется в ноль', () => {
    expect(vec2.normalize(vec2.create(), vec2.create())).toEqual({ x: 0, y: 0 });
    expect(vec2.length(vec2.normalize(vec2.create(), vec2.create(3, 4)))).toBeCloseTo(1);
  });
});

describe('vec3', () => {
  it('арифметика', () => {
    const a = vec3.create(1, 2, 3);
    const b = vec3.create(-2, 0, 1);
    expect(vec3.add(vec3.create(), a, b)).toEqual({ x: -1, y: 2, z: 4 });
    expect(vec3.sub(vec3.create(), a, b)).toEqual({ x: 3, y: 2, z: 2 });
    expect(vec3.mul(vec3.create(), a, b)).toEqual({ x: -2, y: 0, z: 3 });
    expect(vec3.negate(vec3.create(), a)).toEqual({ x: -1, y: -2, z: -3 });
    expect(vec3.dot(a, b)).toBe(1);
    expect(vec3.distanceSq(a, b)).toBe(17);
    expectClose(vec3.lerp(vec3.create(), a, b, 0.5), { x: -0.5, y: 1, z: 2 });
  });

  it('cross подчиняется правилу правой руки', () => {
    const x = vec3.create(1, 0, 0);
    const y = vec3.create(0, 1, 0);
    expect(vec3.cross(vec3.create(), x, y)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('cross корректен при out = a', () => {
    const a = vec3.create(1, 2, 3);
    const b = vec3.create(4, 5, 6);
    const expected = vec3.cross(vec3.create(), a, b);
    expect(vec3.cross(a, a, b)).toEqual(expected);
  });

  it('normalize и equals', () => {
    expect(vec3.normalize(vec3.create(), vec3.create())).toEqual({ x: 0, y: 0, z: 0 });
    expect(vec3.length(vec3.normalize(vec3.create(), vec3.create(1, 2, 2)))).toBeCloseTo(1);
    expect(vec3.equals(vec3.create(1, 2, 3), vec3.create(1, 2, 3 + 1e-9))).toBe(true);
    expect(vec3.equals(vec3.create(1, 2, 3), vec3.create(1, 2, 3.1))).toBe(false);
  });

  it('clone создаёт независимую копию', () => {
    const a = vec3.create(1, 2, 3);
    const b = vec3.clone(a);
    b.x = 9;
    expect(a.x).toBe(1);
  });
});

describe('vec2: остальные операции', () => {
  it('set, copy, clone, scale, negate, lerp, lengthSq, equals', () => {
    const a = vec2.set(vec2.create(), 3, -4);
    expect(vec2.copy(vec2.create(), a)).toEqual({ x: 3, y: -4 });
    const c = vec2.clone(a);
    c.x = 0;
    expect(a.x).toBe(3);
    expect(vec2.scale(vec2.create(), a, 2)).toEqual({ x: 6, y: -8 });
    expect(vec2.negate(vec2.create(), a)).toEqual({ x: -3, y: 4 });
    expect(vec2.lerp(vec2.create(), a, vec2.create(5, 0), 0.5)).toEqual({ x: 4, y: -2 });
    expect(vec2.lengthSq(a)).toBe(25);
    expect(vec2.length(a)).toBe(5);
    expect(vec2.equals(a, vec2.create(3, -4 + 1e-9))).toBe(true);
    expect(vec2.equals(a, vec2.create(3, -4.1))).toBe(false);
  });

  it('все операции допускают out = аргумент', () => {
    const b = vec2.create(-2, 5);
    const cases: [string, (out: vec2.Vec2, a: vec2.Vec2) => vec2.Vec2][] = [
      ['add', (out, a) => vec2.add(out, a, b)],
      ['sub', (out, a) => vec2.sub(out, a, b)],
      ['scale', (out, a) => vec2.scale(out, a, 3)],
      ['scaleAndAdd', (out, a) => vec2.scaleAndAdd(out, a, b, 2)],
      ['negate', (out, a) => vec2.negate(out, a)],
      ['normalize', (out, a) => vec2.normalize(out, a)],
      ['lerp', (out, a) => vec2.lerp(out, a, b, 0.3)],
      ['rotate', (out, a) => vec2.rotate(out, a, 0.7)],
    ];
    for (const [name, op] of cases) {
      const expected = op(vec2.create(), vec2.create(1.5, -0.5));
      const a = vec2.create(1.5, -0.5);
      expect(op(a, a), name).toEqual(expected);
    }
  });
});

describe('vec3: остальные операции', () => {
  it('scale, scaleAndAdd, length, distance, set, copy', () => {
    const a = vec3.set(vec3.create(), 1, 2, 2);
    expect(vec3.copy(vec3.create(), a)).toEqual(a);
    expect(vec3.scale(vec3.create(), a, -2)).toEqual({ x: -2, y: -4, z: -4 });
    expect(vec3.scaleAndAdd(vec3.create(), a, vec3.create(1, 0, -1), 3)).toEqual({
      x: 4,
      y: 2,
      z: -1,
    });
    expect(vec3.length(a)).toBe(3);
    expect(vec3.lengthSq(a)).toBe(9);
    expect(vec3.distance(a, vec3.create(1, 2, -2))).toBe(4);
  });

  it('все операции допускают out = аргумент', () => {
    const b = vec3.create(-2, 5, 0.5);
    const cases: [string, (out: vec3.Vec3, a: vec3.Vec3) => vec3.Vec3][] = [
      ['add', (out, a) => vec3.add(out, a, b)],
      ['sub', (out, a) => vec3.sub(out, a, b)],
      ['mul', (out, a) => vec3.mul(out, a, b)],
      ['scale', (out, a) => vec3.scale(out, a, 3)],
      ['scaleAndAdd a', (out, a) => vec3.scaleAndAdd(out, a, b, 2)],
      ['scaleAndAdd b', (out, a) => vec3.scaleAndAdd(out, b, a, 2)],
      ['negate', (out, a) => vec3.negate(out, a)],
      ['normalize', (out, a) => vec3.normalize(out, a)],
      ['lerp a', (out, a) => vec3.lerp(out, a, b, 0.3)],
      ['lerp b', (out, a) => vec3.lerp(out, b, a, 0.3)],
      ['cross a', (out, a) => vec3.cross(out, a, b)],
      ['cross b', (out, a) => vec3.cross(out, b, a)],
    ];
    for (const [name, op] of cases) {
      const expected = op(vec3.create(), vec3.create(1.5, -0.5, 2));
      const a = vec3.create(1.5, -0.5, 2);
      expect(op(a, a), name).toEqual(expected);
    }
  });
});
