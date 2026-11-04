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
  it('create даёт единичную матрицу', () => {
    const v = vec3.create(1, 2, 3);
    expect(point(mat3x4.create(), v)).toEqual(v);
  });

  it('compose = перенос · поворот · масштаб', () => {
    const next = random(1);
    for (let i = 0; i < 50; i++) {
      const { translation, rotation, scale } = randomTransform(next);
      const m = mat3x4.compose(mat3x4.create(), translation, rotation, scale);
      const v = vec3.create(range(next, -10, 10), range(next, -10, 10), range(next, -10, 10));
      const expected = vec3.mul(vec3.create(), v, scale);
      quat.transformVec3(expected, rotation, expected);
      vec3.add(expected, expected, translation);
      expectClose(point(m, v), expected);
    }
  });

  it('pivot остаётся на месте при повороте и масштабе', () => {
    const pivot = vec3.create(5, -3, 2);
    const rotation = quat.setAxisAngle(quat.create(), vec3.create(0, 0, 1), 1.2);
    const m = mat3x4.compose(mat3x4.create(), vec3.create(), rotation, vec3.create(2, 2, 2), pivot);
    expectClose(point(m, pivot), pivot);
  });

  it('pivot со сдвигом переносит точку pivot на translation', () => {
    const pivot = vec3.create(5, -3, 2);
    const translation = vec3.create(10, 0, -4);
    const rotation = quat.setAxisAngle(quat.create(), vec3.create(1, 0, 0), 0.5);
    const m = mat3x4.compose(mat3x4.create(), translation, rotation, vec3.create(1, 1, 1), pivot);
    expectClose(point(m, pivot), vec3.add(vec3.create(), pivot, translation));
  });

  it('multiply(a, b) применяет сначала b, потом a, и допускает out = a', () => {
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

  it('invert обращает преобразование', () => {
    const next = random(3);
    for (let i = 0; i < 50; i++) {
      const { translation, rotation, scale } = randomTransform(next);
      const m = mat3x4.compose(mat3x4.create(), translation, rotation, scale);
      const inv = mat3x4.invert(mat3x4.create(), m);
      expect(inv).not.toBeNull();
      if (!inv) return;
      expect(mat3x4.equals(mat3x4.multiply(mat3x4.create(), m, inv), mat3x4.create(), 1e-9)).toBe(
        true,
      );
      const copy = mat3x4.clone(m);
      mat3x4.invert(copy, copy);
      expect(mat3x4.equals(copy, inv)).toBe(true);
    }
  });

  it('invert вырожденной матрицы возвращает null и не трогает out', () => {
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

  it('determinant равен произведению масштабов', () => {
    const rotation = quat.setAxisAngle(quat.create(), vec3.create(0, 1, 0), 0.8);
    const m = mat3x4.compose(mat3x4.create(), vec3.create(9, 9, 9), rotation, vec3.create(2, 3, 4));
    expect(mat3x4.determinant(m)).toBeCloseTo(24);
  });

  it('transformDirection не учитывает перенос', () => {
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

  it('fromQuat совпадает с поворотом кватернионом', () => {
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
