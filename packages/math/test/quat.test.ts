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
  it('положительный угол поворачивает по правилу правой руки', () => {
    expectClose(rotate(axisAngle(Z, Math.PI / 2), X), { x: 0, y: 1, z: 0 });
    expectClose(rotate(axisAngle(X, Math.PI / 2), Y), { x: 0, y: 0, z: 1 });
    expectClose(rotate(axisAngle(Y, Math.PI / 2), Z), { x: 1, y: 0, z: 0 });
  });

  it('multiply(a, b) применяет сначала b, потом a', () => {
    const a = axisAngle(X, 0.7);
    const b = axisAngle(Z, 1.3);
    const v = vec3.create(0.3, -1.2, 2);
    expectClose(rotate(quat.multiply(quat.create(), a, b), v), rotate(a, rotate(b, v)));
  });

  it('multiply корректен при out = a и out = b', () => {
    const a = axisAngle(X, 0.7);
    const b = axisAngle(Y, -0.4);
    const expected = quat.multiply(quat.create(), a, b);
    expect(quat.multiply(quat.clone(a), quat.clone(a), b)).toEqual(expected);
    const bb = quat.clone(b);
    expect(quat.multiply(bb, a, bb)).toEqual(expected);
  });

  it('conjugate и invert дают обратный поворот', () => {
    const q = axisAngle(vec3.normalize(vec3.create(), vec3.create(1, 2, 3)), 1.1);
    const id = quat.create();
    expect(quat.equals(quat.multiply(quat.create(), q, quat.conjugate(quat.create(), q)), id)).toBe(
      true,
    );
    const scaled = quat.set(quat.create(), q.x * 2, q.y * 2, q.z * 2, q.w * 2);
    const product = quat.multiply(quat.create(), scaled, quat.invert(quat.create(), scaled));
    expect(quat.equals(product, id)).toBe(true);
  });

  it('normalize делает кватернион единичным, нулевой становится единичным', () => {
    expect(quat.length(quat.normalize(quat.create(), { x: 1, y: 2, z: 3, w: 4 }))).toBeCloseTo(1);
    expect(quat.normalize(quat.create(), { x: 0, y: 0, z: 0, w: 0 })).toEqual(quat.create());
  });

  it('slerp: концы, середина, кратчайший путь', () => {
    const a = quat.create();
    const b = axisAngle(Z, Math.PI / 2);
    expect(quat.equalsRotation(quat.slerp(quat.create(), a, b, 0), a)).toBe(true);
    expect(quat.equalsRotation(quat.slerp(quat.create(), a, b, 1), b)).toBe(true);
    expect(
      quat.equalsRotation(quat.slerp(quat.create(), a, b, 0.5), axisAngle(Z, Math.PI / 4)),
    ).toBe(true);
    // -b задаёт тот же поворот: путь всё равно должен быть коротким.
    const negB = quat.set(quat.create(), -b.x, -b.y, -b.z, -b.w);
    expect(
      quat.equalsRotation(quat.slerp(quat.create(), a, negB, 0.5), axisAngle(Z, Math.PI / 4)),
    ).toBe(true);
  });

  it('slerp почти одинаковых поворотов не даёт NaN', () => {
    const a = axisAngle(X, 0.5);
    const b = axisAngle(X, 0.5 + 1e-9);
    const result = quat.slerp(quat.create(), a, b, 0.5);
    expect(Number.isNaN(result.w)).toBe(false);
    expect(quat.equalsRotation(result, a)).toBe(true);
  });

  it('equalsRotation считает q и -q одним поворотом', () => {
    const q = axisAngle(Y, 1);
    const neg = quat.set(quat.create(), -q.x, -q.y, -q.z, -q.w);
    expect(quat.equalsRotation(q, neg)).toBe(true);
    expect(quat.equals(q, neg)).toBe(false);
  });
});

describe('углы Эйлера', () => {
  it("'XYZ' означает Rx · Ry · Rz", () => {
    const e = euler.create(0.4, -0.9, 1.7, 'XYZ');
    const expected = quat.multiply(
      quat.create(),
      quat.multiply(quat.create(), axisAngle(X, e.x), axisAngle(Y, e.y)),
      axisAngle(Z, e.z),
    );
    expect(quat.equalsRotation(quat.fromEuler(quat.create(), e), expected)).toBe(true);
  });

  it('каждый порядок даёт произведение поворотов в порядке записи', () => {
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

  it('toEuler обращает fromEuler для всех порядков', () => {
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
        // Средний угол однозначен только в диапазоне (-π/2, π/2).
        e[middle] = range(next, -1.5, 1.5);
        const q = quat.fromEuler(quat.create(), e);
        const back = quat.toEuler(euler.create(), q, order);
        expect(back.order).toBe(order);
        expectClose(back, e, 6);
      }
    }
  });

  it('toEuler в блокировке осей даёт тот же поворот', () => {
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

describe('quat: сравнение поворотов', () => {
  it('angleBetween точен для малых и больших углов', () => {
    const id = quat.create();
    for (const angle of [1e-8, 2.5e-3, 0.5, Math.PI / 2, Math.PI]) {
      expect(quat.angleBetween(id, axisAngle(X, angle)), String(angle)).toBeCloseTo(angle, 12);
    }
    const q = axisAngle(Y, 0.3);
    const neg = quat.set(quat.create(), -q.x, -q.y, -q.z, -q.w);
    expect(quat.angleBetween(q, neg)).toBeCloseTo(0, 12);
  });

  it('equalsRotation сравнивает угол, а не скалярное произведение', () => {
    const id = quat.create();
    const near = axisAngle(Z, 2.5e-3);
    expect(quat.equalsRotation(id, near)).toBe(false);
    expect(quat.equalsRotation(id, near, 3e-3)).toBe(true);
    expect(quat.equalsRotation(id, axisAngle(Z, 5e-7))).toBe(true);
  });
});

describe('quat: остальные операции', () => {
  it('dot, copy, identity, invert нулевого', () => {
    const q = quat.set(quat.create(), 1, 2, 3, 4);
    expect(quat.dot(q, q)).toBe(30);
    expect(quat.copy(quat.create(), q)).toEqual(q);
    expect(quat.identity(q)).toEqual(quat.create());
    expect(quat.invert(quat.create(), { x: 0, y: 0, z: 0, w: 0 })).toEqual(quat.create());
  });

  it('slerp за пределами [0, 1] продолжает вращение', () => {
    const a = quat.create();
    const b = axisAngle(Z, Math.PI / 4);
    expect(quat.equalsRotation(quat.slerp(quat.create(), a, b, 2), axisAngle(Z, Math.PI / 2))).toBe(
      true,
    );
    const back = quat.slerp(quat.create(), a, b, -1);
    expect(Number.isNaN(back.w)).toBe(false);
    expect(quat.equalsRotation(back, axisAngle(Z, -Math.PI / 4))).toBe(true);
  });

  it('все операции допускают out = аргумент', () => {
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

  it('transformVec3 допускает out = v', () => {
    const q = axisAngle(vec3.normalize(vec3.create(), vec3.create(1, 1, 1)), 1.3);
    const v = vec3.create(2, -1, 0.5);
    const expected = quat.transformVec3(vec3.create(), q, v);
    expect(quat.transformVec3(v, q, v)).toEqual(expected);
  });
});

describe('углы Эйлера: границы', () => {
  it('euler.create, isEulerOrder и порядок по умолчанию в toEuler', () => {
    expect(euler.create()).toEqual({ x: 0, y: 0, z: 0, order: 'XYZ' });
    expect(isEulerOrder('ZYX')).toBe(true);
    expect(isEulerOrder('xyz')).toBe(false);
    const q = quat.fromEuler(quat.create(), euler.create(0.1, 0.2, 0.3, 'YZX'));
    expect(quat.toEuler(euler.create(0, 0, 0, 'YZX'), q).order).toBe('YZX');
    expectClose(quat.toEuler(euler.create(0, 0, 0, 'YZX'), q), euler.create(0.1, 0.2, 0.3, 'YZX'));
  });

  it('в блокировке осей ±π/2 последний угол обнуляется, поворот сохраняется', () => {
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

  it('около блокировки осей углы восстанавливаются точно', () => {
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
          // Ошибка ограничена точностью double: около 1e-16 / cos(среднего угла).
          expect(quat.angleBetween(quat.fromEuler(quat.create(), back), q), label).toBeLessThan(
            1e-8,
          );
        }
      }
    }
  });
});
