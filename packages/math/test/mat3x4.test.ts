import { describe, expect, it } from 'vitest';
import { mat3x4, quat, type Vec3, vec3 } from '../src/index.ts';
import { expectClose, random, range } from './helpers.ts';

function randomTransform(next: () => number) {
  const axis = vec3.normalize(
    vec3.create(),
    vec3.create(range(next, -1, 1), range(next, -1, 1), range(next, -1, 1)),
  );
  return {
    translation: vec3.create(range(next, -50, 50), range(next, -50, 50), range(next, -50, 50)),
    rotation: quat.setAxisAngle(quat.create(), axis, range(next, -Math.PI, Math.PI)),
    scale: vec3.create(range(next, 0.2, 3), range(next, 0.2, 3), range(next, 0.2, 3)),
  };
}

function point(m: mat3x4.Mat3x4, v: Vec3): Vec3 {
  return mat3x4.transformPoint(vec3.create(), m, v);
}

describe('mat3x4', () => {
  it('create gives the identity matrix', () => {
    const v = vec3.create(1, 2, 3);
    expect(point(mat3x4.create(), v)).toEqual(v);
  });

  it('compose = translation · rotation · scale', () => {
    const next = random(1);
    for (let i = 0; i < 50; i++) {
      const { translation, rotation, scale } = randomTransform(next);
      const m = mat3x4.compose(mat3x4.create(), translation, rotation, scale);
      const v = vec3.create(range(next, -10, 10), range(next, -10, 10), range(next, -10, 10));
      const expected = vec3.mul(vec3.create(), v, scale);
      quat.transformVec3(expected, rotation, expected);
      vec3.add(expected, expected, translation);
      expectClose(point(m, v), expected, 7);
    }
  });

  it('pivot: rotation and scale about a point for arbitrary points', () => {
    const next = random(4);
    for (let i = 0; i < 50; i++) {
      const { translation, rotation, scale } = randomTransform(next);
      const pivot = vec3.create(range(next, -20, 20), range(next, -20, 20), range(next, -20, 20));
      const m = mat3x4.compose(mat3x4.create(), translation, rotation, scale, pivot);
      const v = vec3.create(range(next, -10, 10), range(next, -10, 10), range(next, -10, 10));
      // R · (S · (v − p)) + p + t
      const expected = vec3.sub(vec3.create(), v, pivot);
      vec3.mul(expected, expected, scale);
      quat.transformVec3(expected, rotation, expected);
      vec3.add(expected, expected, pivot);
      vec3.add(expected, expected, translation);
      expectClose(point(m, v), expected, 7);
    }
  });

  it('pivot stays in place under rotation and scale', () => {
    const pivot = vec3.create(5, -3, 2);
    const rotation = quat.setAxisAngle(quat.create(), vec3.create(0, 0, 1), 1.2);
    const m = mat3x4.compose(mat3x4.create(), vec3.create(), rotation, vec3.create(2, 2, 2), pivot);
    expectClose(point(m, pivot), pivot);
  });

  it('pivot with translation moves the pivot point to translation', () => {
    const pivot = vec3.create(5, -3, 2);
    const translation = vec3.create(10, 0, -4);
    const rotation = quat.setAxisAngle(quat.create(), vec3.create(1, 0, 0), 0.5);
    const m = mat3x4.compose(mat3x4.create(), translation, rotation, vec3.create(1, 1, 1), pivot);
    expectClose(point(m, pivot), vec3.add(vec3.create(), pivot, translation));
  });

  it('multiply(a, b) applies b first, then a, and allows out = a', () => {
    const next = random(2);
    const ta = randomTransform(next);
    const tb = randomTransform(next);
    const a = mat3x4.compose(mat3x4.create(), ta.translation, ta.rotation, ta.scale);
    const b = mat3x4.compose(mat3x4.create(), tb.translation, tb.rotation, tb.scale);
    const v = vec3.create(1, -2, 3);
    const ab = mat3x4.multiply(mat3x4.create(), a, b);
    expectClose(point(ab, v), point(a, point(b, v)));
    expect(mat3x4.equals(mat3x4.multiply(mat3x4.clone(a), mat3x4.clone(a), b), ab)).toBe(true);
    const bb = mat3x4.clone(b);
    expect(mat3x4.equals(mat3x4.multiply(bb, a, bb), ab)).toBe(true);
  });

  it('invert inverts the transform', () => {
    const next = random(3);
    for (let i = 0; i < 50; i++) {
      const { translation, rotation, scale } = randomTransform(next);
      const m = mat3x4.compose(mat3x4.create(), translation, rotation, scale);
      const inv = mat3x4.invert(mat3x4.create(), m);
      if (!inv) throw new Error('matrix must be invertible');
      expect(mat3x4.equals(mat3x4.multiply(mat3x4.create(), m, inv), mat3x4.create(), 1e-9)).toBe(
        true,
      );
      const copy = mat3x4.clone(m);
      mat3x4.invert(copy, copy);
      expect(mat3x4.equals(copy, inv)).toBe(true);
    }
  });

  it('invert of a singular matrix returns null and leaves out untouched', () => {
    const singular = mat3x4.compose(
      mat3x4.create(),
      vec3.create(),
      quat.create(),
      vec3.create(1, 0, 1),
    );
    const out = mat3x4.create();
    expect(mat3x4.invert(out, singular)).toBeNull();
    expect(mat3x4.equals(out, mat3x4.create())).toBe(true);
  });

  it('negative scale: a reflection with det < 0 is invertible', () => {
    const rotation = quat.setAxisAngle(quat.create(), vec3.create(0, 0, 1), 0.4);
    const m = mat3x4.compose(
      mat3x4.create(),
      vec3.create(3, 1, 2),
      rotation,
      vec3.create(-1, 1, 1),
    );
    expect(mat3x4.determinant(m)).toBeCloseTo(-1);
    const inv = mat3x4.invert(mat3x4.create(), m);
    if (!inv) throw new Error('reflection must be invertible');
    expect(mat3x4.equals(mat3x4.multiply(mat3x4.create(), inv, m), mat3x4.create(), 1e-12)).toBe(
      true,
    );
  });

  it('a very small but genuine scale is invertible', () => {
    const tiny = vec3.create(1e-5, 1e-5, 1e-5);
    const m = mat3x4.compose(mat3x4.create(), vec3.create(1, 2, 3), quat.create(), tiny);
    const inv = mat3x4.invert(mat3x4.create(), m);
    if (!inv) throw new Error('scale 1e-5 must be invertible');
    const v = vec3.create(4, -5, 6);
    expectClose(point(inv, point(m, v)), v, 6);
  });

  it('a matrix with parallel columns is singular', () => {
    const m = mat3x4.fromArray([1, 2, 3, 2, 4, 6, 0, 0, 1, 5, 5, 5]);
    expect(mat3x4.invert(mat3x4.create(), m)).toBeNull();
  });

  it('fromArray checks the length', () => {
    expect(() => mat3x4.fromArray(new Float64Array(16))).toThrow(RangeError);
    const values = [1, 0, 0, 0, 1, 0, 0, 0, 1, 7, 8, 9];
    expect(Array.from(mat3x4.fromArray(values))).toEqual(values);
  });

  it('copy and identity overwrite the whole matrix', () => {
    const dirty = mat3x4.fromArray([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    expect(mat3x4.equals(mat3x4.identity(dirty), mat3x4.create())).toBe(true);
    const source = mat3x4.fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(mat3x4.copy(mat3x4.create(), source))).toEqual(Array.from(source));
  });

  it('transformPoint and transformDirection allow out = v', () => {
    const rotation = quat.setAxisAngle(quat.create(), vec3.create(1, 0, 0), 0.9);
    const m = mat3x4.compose(mat3x4.create(), vec3.create(1, 2, 3), rotation, vec3.create(2, 1, 3));
    const v = vec3.create(0.5, -1, 2);
    const p = point(m, v);
    const d = mat3x4.transformDirection(vec3.create(), m, v);
    expect(mat3x4.transformPoint(vec3.clone(v), m, vec3.clone(v))).toEqual(p);
    const w = vec3.clone(v);
    expect(mat3x4.transformDirection(w, m, w)).toEqual(d);
  });

  it('determinant equals the product of the scales', () => {
    const rotation = quat.setAxisAngle(quat.create(), vec3.create(0, 1, 0), 0.8);
    const m = mat3x4.compose(mat3x4.create(), vec3.create(9, 9, 9), rotation, vec3.create(2, 3, 4));
    expect(mat3x4.determinant(m)).toBeCloseTo(24);
  });

  it('transformDirection ignores translation', () => {
    const m = mat3x4.compose(
      mat3x4.create(),
      vec3.create(10, 20, 30),
      quat.create(),
      vec3.create(2, 2, 2),
    );
    const out = mat3x4.transformDirection(vec3.create(), m, vec3.create(1, 0, 0));
    expect(out).toEqual({ x: 2, y: 0, z: 0 });
    expect(mat3x4.getTranslation(vec3.create(), m)).toEqual({ x: 10, y: 20, z: 30 });
  });

  it('fromQuat matches rotation by the quaternion', () => {
    const q = quat.setAxisAngle(
      quat.create(),
      vec3.normalize(vec3.create(), vec3.create(1, 1, 0)),
      2,
    );
    const v = vec3.create(0.5, -1, 4);
    expectClose(
      point(mat3x4.fromQuat(mat3x4.create(), q), v),
      quat.transformVec3(vec3.create(), q, v),
    );
  });
});
