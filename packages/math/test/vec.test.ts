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
