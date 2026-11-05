import { describe, expect, it } from 'vitest';
import { EULER_ORDERS, isEulerOrder } from '../src/euler.ts';
import { euler, type Quat, quat, vec3 } from '../src/index.ts';
import { expectClose, random, range } from './helpers.ts';

const X = vec3.create(1, 0, 0);
const Y = vec3.create(0, 1, 0);
const Z = vec3.create(0, 0, 1);

function axisAngle(axis: vec3.Vec3, angle: number): Quat {
  return quat.setAxisAngle(quat.create(), axis, angle);
}

function rotate(q: Quat, v: vec3.Vec3): vec3.Vec3 {
  return quat.transformVec3(vec3.create(), q, v);
}

describe('quat', () => {
  it('a positive angle rotates by the right-hand rule', () => {
    expectClose(rotate(axisAngle(Z, Math.PI / 2), X), { x: 0, y: 1, z: 0 });
    expectClose(rotate(axisAngle(X, Math.PI / 2), Y), { x: 0, y: 0, z: 1 });
    expectClose(rotate(axisAngle(Y, Math.PI / 2), Z), { x: 1, y: 0, z: 0 });
  });

  it('multiply(a, b) applies b first, then a', () => {
    const a = axisAngle(X, 0.7);
    const b = axisAngle(Z, 1.3);
    const v = vec3.create(0.3, -1.2, 2);
    expectClose(rotate(quat.multiply(quat.create(), a, b), v), rotate(a, rotate(b, v)));
  });

  it('multiply is correct with out = a and out = b', () => {
    const a = axisAngle(X, 0.7);
    const b = axisAngle(Y, -0.4);
    const expected = quat.multiply(quat.create(), a, b);
    expect(quat.multiply(quat.clone(a), quat.clone(a), b)).toEqual(expected);
    const bb = quat.clone(b);
    expect(quat.multiply(bb, a, bb)).toEqual(expected);
  });

  it('conjugate and invert give the inverse rotation', () => {
    const q = axisAngle(vec3.normalize(vec3.create(), vec3.create(1, 2, 3)), 1.1);
    const id = quat.create();
    expect(quat.equals(quat.multiply(quat.create(), q, quat.conjugate(quat.create(), q)), id)).toBe(
      true,
    );
    const scaled = quat.set(quat.create(), q.x * 2, q.y * 2, q.z * 2, q.w * 2);
    const product = quat.multiply(quat.create(), scaled, quat.invert(quat.create(), scaled));
    expect(quat.equals(product, id)).toBe(true);
  });

  it('normalize makes a quaternion unit, a zero one becomes the identity', () => {
    expect(quat.length(quat.normalize(quat.create(), { x: 1, y: 2, z: 3, w: 4 }))).toBeCloseTo(1);
    expect(quat.normalize(quat.create(), { x: 0, y: 0, z: 0, w: 0 })).toEqual(quat.create());
  });

  it('slerp: ends, midpoint, shortest path', () => {
    const a = quat.create();
    const b = axisAngle(Z, Math.PI / 2);
    expect(quat.equalsRotation(quat.slerp(quat.create(), a, b, 0), a)).toBe(true);
    expect(quat.equalsRotation(quat.slerp(quat.create(), a, b, 1), b)).toBe(true);
    expect(
      quat.equalsRotation(quat.slerp(quat.create(), a, b, 0.5), axisAngle(Z, Math.PI / 4)),
    ).toBe(true);
    // -b is the same rotation: the path must still be the short one.
    const negB = quat.set(quat.create(), -b.x, -b.y, -b.z, -b.w);
    expect(
      quat.equalsRotation(quat.slerp(quat.create(), a, negB, 0.5), axisAngle(Z, Math.PI / 4)),
    ).toBe(true);
  });

  it('slerp of nearly identical rotations does not give NaN', () => {
    const a = axisAngle(X, 0.5);
    const b = axisAngle(X, 0.5 + 1e-9);
    const result = quat.slerp(quat.create(), a, b, 0.5);
    expect(Number.isNaN(result.w)).toBe(false);
    expect(quat.equalsRotation(result, a)).toBe(true);
  });

  it('equalsRotation treats q and -q as the same rotation', () => {
    const q = axisAngle(Y, 1);
    const neg = quat.set(quat.create(), -q.x, -q.y, -q.z, -q.w);
    expect(quat.equalsRotation(q, neg)).toBe(true);
    expect(quat.equals(q, neg)).toBe(false);
  });
});

describe('Euler angles', () => {
  it("'XYZ' means Rx · Ry · Rz", () => {
    const e = euler.create(0.4, -0.9, 1.7, 'XYZ');
    const expected = quat.multiply(
      quat.create(),
      quat.multiply(quat.create(), axisAngle(X, e.x), axisAngle(Y, e.y)),
      axisAngle(Z, e.z),
    );
    expect(quat.equalsRotation(quat.fromEuler(quat.create(), e), expected)).toBe(true);
  });

  it('each order gives the product of rotations in the written order', () => {
    const axes = { X, Y, Z };
    const e = { x: 0.3, y: 1.1, z: -0.8 };
    for (const order of EULER_ORDERS) {
      const expected = quat.create();
      for (const axis of order as Iterable<'X' | 'Y' | 'Z'>) {
        const angle = e[axis.toLowerCase() as 'x' | 'y' | 'z'];
        quat.multiply(expected, expected, axisAngle(axes[axis], angle));
      }
      const actual = quat.fromEuler(quat.create(), { ...e, order });
      expect(quat.equalsRotation(actual, expected), order).toBe(true);
    }
  });

  it('toEuler inverts fromEuler for all orders', () => {
    const next = random(42);
    for (const order of EULER_ORDERS) {
      const middle = order[1]?.toLowerCase() as 'x' | 'y' | 'z';
      for (let i = 0; i < 200; i++) {
        const e = euler.create(
          range(next, -Math.PI, Math.PI),
          range(next, -Math.PI, Math.PI),
          range(next, -Math.PI, Math.PI),
          order,
        );
        // The middle angle is unique only in the range (-π/2, π/2).
        e[middle] = range(next, -1.5, 1.5);
        const q = quat.fromEuler(quat.create(), e);
        const back = quat.toEuler(euler.create(), q, order);
        expect(back.order).toBe(order);
        expectClose(back, e, 6);
      }
    }
  });

  it('toEuler in gimbal lock gives the same rotation', () => {
    for (const order of EULER_ORDERS) {
      const middle = order[1]?.toLowerCase() as 'x' | 'y' | 'z';
      const e = euler.create(0.3, 0.6, 0.9, order);
      e[middle] = Math.PI / 2;
      const q = quat.fromEuler(quat.create(), e);
      const back = quat.toEuler(euler.create(), q, order);
      expect(quat.equalsRotation(quat.fromEuler(quat.create(), back), q), order).toBe(true);
    }
  });
});

describe('quat: rotation comparison', () => {
  it('angleBetween is accurate for small and large angles', () => {
    const id = quat.create();
    for (const angle of [1e-8, 2.5e-3, 0.5, Math.PI / 2, Math.PI]) {
      expect(quat.angleBetween(id, axisAngle(X, angle)), String(angle)).toBeCloseTo(angle, 12);
    }
    const q = axisAngle(Y, 0.3);
    const neg = quat.set(quat.create(), -q.x, -q.y, -q.z, -q.w);
    expect(quat.angleBetween(q, neg)).toBeCloseTo(0, 12);
  });

  it('equalsRotation compares the angle, not the dot product', () => {
    const id = quat.create();
    const near = axisAngle(Z, 2.5e-3);
    expect(quat.equalsRotation(id, near)).toBe(false);
    expect(quat.equalsRotation(id, near, 3e-3)).toBe(true);
    expect(quat.equalsRotation(id, axisAngle(Z, 5e-7))).toBe(true);
  });
});

describe('quat: other operations', () => {
  it('dot, copy, identity, invert of zero', () => {
    const q = quat.set(quat.create(), 1, 2, 3, 4);
    expect(quat.dot(q, q)).toBe(30);
    expect(quat.copy(quat.create(), q)).toEqual(q);
    expect(quat.identity(q)).toEqual(quat.create());
    expect(quat.invert(quat.create(), { x: 0, y: 0, z: 0, w: 0 })).toEqual(quat.create());
  });

  it('slerp outside [0, 1] continues the rotation', () => {
    const a = quat.create();
    const b = axisAngle(Z, Math.PI / 4);
    expect(quat.equalsRotation(quat.slerp(quat.create(), a, b, 2), axisAngle(Z, Math.PI / 2))).toBe(
      true,
    );
    const back = quat.slerp(quat.create(), a, b, -1);
    expect(Number.isNaN(back.w)).toBe(false);
    expect(quat.equalsRotation(back, axisAngle(Z, -Math.PI / 4))).toBe(true);
  });

  it('all operations allow out = argument', () => {
    const b = axisAngle(vec3.normalize(vec3.create(), vec3.create(1, -2, 0.5)), 2.1);
    const make = () => axisAngle(vec3.normalize(vec3.create(), vec3.create(0.3, 1, -1)), 0.8);
    const cases: [string, (out: Quat, a: Quat) => Quat][] = [
      ['normalize', (out, a) => quat.normalize(out, a)],
      ['conjugate', (out, a) => quat.conjugate(out, a)],
      ['invert', (out, a) => quat.invert(out, a)],
      ['slerp a', (out, a) => quat.slerp(out, a, b, 0.3)],
      ['slerp b', (out, a) => quat.slerp(out, b, a, 0.3)],
      ['multiply a', (out, a) => quat.multiply(out, a, b)],
      ['multiply b', (out, a) => quat.multiply(out, b, a)],
    ];
    for (const [name, op] of cases) {
      const expected = op(quat.create(), make());
      const a = make();
      expect(op(a, a), name).toEqual(expected);
    }
  });

  it('transformVec3 allows out = v', () => {
    const q = axisAngle(vec3.normalize(vec3.create(), vec3.create(1, 1, 1)), 1.3);
    const v = vec3.create(2, -1, 0.5);
    const expected = quat.transformVec3(vec3.create(), q, v);
    expect(quat.transformVec3(v, q, v)).toEqual(expected);
  });
});

describe('Euler angles: edge cases', () => {
  it('euler.create, isEulerOrder and the default order in toEuler', () => {
    expect(euler.create()).toEqual({ x: 0, y: 0, z: 0, order: 'XYZ' });
    expect(isEulerOrder('ZYX')).toBe(true);
    expect(isEulerOrder('xyz')).toBe(false);
    const q = quat.fromEuler(quat.create(), euler.create(0.1, 0.2, 0.3, 'YZX'));
    expect(quat.toEuler(euler.create(0, 0, 0, 'YZX'), q).order).toBe('YZX');
    expectClose(quat.toEuler(euler.create(0, 0, 0, 'YZX'), q), euler.create(0.1, 0.2, 0.3, 'YZX'));
  });

  it('in gimbal lock at ±π/2 the last angle is zeroed and the rotation is preserved', () => {
    for (const order of EULER_ORDERS) {
      const middle = order[1]?.toLowerCase() as 'x' | 'y' | 'z';
      const last = order[2]?.toLowerCase() as 'x' | 'y' | 'z';
      for (const sign of [1, -1]) {
        const e = euler.create(0.3, 0.6, 0.9, order);
        e[middle] = (sign * Math.PI) / 2;
        const q = quat.fromEuler(quat.create(), e);
        const back = quat.toEuler(euler.create(), q, order);
        expect(back[last], `${order} ${sign}`).toBe(0);
        expect(back[middle], `${order} ${sign}`).toBeCloseTo(e[middle], 9);
        expect(quat.angleBetween(quat.fromEuler(quat.create(), back), q)).toBeLessThan(1e-9);
      }
    }
  });

  it('angles are recovered accurately near gimbal lock', () => {
    for (const order of EULER_ORDERS) {
      const middle = order[1]?.toLowerCase() as 'x' | 'y' | 'z';
      for (const offset of [1e-3, 4e-4, 1e-5, 1e-7]) {
        for (const sign of [1, -1]) {
          const e = euler.create(0.3, 0.6, 0.9, order);
          e[middle] = sign * (Math.PI / 2 - offset);
          const q = quat.fromEuler(quat.create(), e);
          const back = quat.toEuler(euler.create(), q, order);
          const label = `${order} ${sign} ${offset}`;
          expect(back[middle], label).toBeCloseTo(e[middle], 9);
          // The error is bounded by double precision: about 1e-16 / cos(middle angle).
          expect(quat.angleBetween(quat.fromEuler(quat.create(), back), q), label).toBeLessThan(
            1e-8,
          );
        }
      }
    }
  });
});

describe('quat: rotationTo', () => {
  it('turns one direction into another along the shortest arc', () => {
    const next = random(21);
    const point = () => vec3.create(range(next, -1, 1), range(next, -1, 1), range(next, -1, 1));
    for (let i = 0; i < 50; i++) {
      const from = point();
      const to = point();
      const q = quat.rotationTo(quat.create(), from, to);
      expect(quat.length(q)).toBeCloseTo(1, 12);
      const turned = vec3.normalize(vec3.create(), rotate(q, from));
      expectClose(turned, vec3.normalize(vec3.create(), to));
      const cos = vec3.dot(from, to) / (vec3.length(from) * vec3.length(to));
      expect(quat.angleBetween(q, quat.create())).toBeCloseTo(Math.acos(cos), 9);
    }
  });

  it('gives the identity for equal directions and zero vectors', () => {
    expect(
      quat.equalsRotation(quat.rotationTo(quat.create(), X, vec3.create(3, 0, 0)), quat.create()),
    ).toBe(true);
    expect(quat.rotationTo(quat.create(), vec3.create(), Y)).toEqual(quat.create());
    expect(quat.rotationTo(quat.create(), Y, vec3.create())).toEqual(quat.create());
  });

  it('turns opposite directions by π about a perpendicular axis', () => {
    for (const from of [X, Y, Z, vec3.create(1, 2, 3), vec3.create(-3, 0.5, 0.1)]) {
      const to = vec3.scale(vec3.create(), from, -2);
      const q = quat.rotationTo(quat.create(), from, to);
      expect(q.w).toBeCloseTo(0, 12);
      expect(quat.length(q)).toBeCloseTo(1, 12);
      expectClose(
        vec3.normalize(vec3.create(), rotate(q, from)),
        vec3.normalize(vec3.create(), to),
      );
    }
  });

  it('turns nearly opposite directions accurately', () => {
    for (const y of [1e-7, 1e-13]) {
      const to = vec3.create(-1, y, 0);
      const q = quat.rotationTo(quat.create(), X, to);
      expect(quat.length(q)).toBeCloseTo(1, 12);
      expectClose(vec3.normalize(vec3.create(), rotate(q, X)), vec3.normalize(vec3.create(), to));
    }
    const q = quat.rotationTo(quat.create(), X, vec3.create(-1, 1e-7, 0));
    expect(quat.angleBetween(q, quat.create())).toBeCloseTo(Math.PI - 1e-7, 9);
  });

  it('returns out', () => {
    const out = quat.create();
    expect(quat.rotationTo(out, X, Y)).toBe(out);
  });
});
