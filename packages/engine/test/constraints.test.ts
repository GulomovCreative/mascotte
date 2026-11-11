import { euler, mat3x4, quat, type Vec3, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  type AimSpec,
  Animator,
  Camera,
  createProjectedPoint,
  Node,
  Rig,
  Scene,
} from '../src/index.ts';

function expectVec(actual: Readonly<Vec3>, expected: Readonly<Vec3>, digits = 9) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

/** The world direction of `node`'s local `axis`, normalized. */
function worldAxis(node: Node, axis: Readonly<Vec3> = { x: 0, y: 0, z: 1 }): Vec3 {
  const out = mat3x4.transformDirection(vec3.create(), node.worldMatrix, axis);
  return vec3.normalize(out, out);
}

function unit(x: number, y: number, z: number): Vec3 {
  return vec3.normalize(vec3.create(), { x, y, z });
}

function angleOf(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.acos(Math.min(1, Math.max(-1, vec3.dot(a, b))));
}

function rotationZ(angle: number) {
  return quat.fromEuler(quat.create(), euler.create(0, 0, angle));
}

/** A head at (0, −20, 0) under a body, in a scene with an animator. */
function head() {
  const scene = new Scene();
  const body = new Node({ id: 'body' });
  const node = new Node({ id: 'head', position: { x: 0, y: -20, z: 0 } });
  body.add(node);
  scene.root.add(body);
  return { scene, body, head: node, animator: new Animator(scene) };
}

describe('aim', () => {
  it('turns the axis to point at the goal', () => {
    const { head: node, animator } = head();
    const aim = animator.addConstraint({
      kind: 'aim',
      target: 'head',
      point: { x: 30, y: -20, z: 30 },
    });
    expect(aim.kind).toBe('aim');
    expect(aim.node).toBe(node);
    animator.evaluate();
    expectVec(worldAxis(node), unit(1, 0, 1));
    expectVec(node.position, { x: 0, y: -20, z: 0 });
  });

  it('works under a turned and scaled parent, and leaves the pose roll alone', () => {
    const { body, head: node, animator } = head();
    body.rotation.copy(quat.fromEuler(quat.create(), euler.create(0.3, -0.5, 0.2)));
    body.scale.set(2, 2, 2);
    // A roll about the axis itself: aiming straight ahead keeps it.
    node.rotation.copy(quat.setAxisAngle(quat.create(), { x: 0, y: 0, z: 1 }, 0.7));
    animator.addConstraint({ kind: 'aim', target: 'head', point: { x: -40, y: 10, z: 25 } });
    animator.evaluate();
    const center = node.localToWorld(vec3.create(), node.pivot);
    expectVec(
      worldAxis(node),
      vec3.normalize(vec3.create(), vec3.sub(center, { x: -40, y: 10, z: 25 }, center)),
    );
  });

  it('does nothing without a goal, and follows a node given as `at`', () => {
    const { scene, head: node, animator } = head();
    const aim = animator.addConstraint({ kind: 'aim', target: 'head' });
    expect(aim.point).toBeNull();
    animator.evaluate();
    expectVec(worldAxis(node), { x: 0, y: 0, z: 1 });
    const ball = new Node({ id: 'ball', position: { x: 0, y: 30, z: 50 } });
    scene.root.add(ball);
    animator.removeConstraint(aim);
    const follow = animator.addConstraint({ kind: 'aim', target: 'head', at: 'ball' });
    animator.evaluate();
    expectVec(worldAxis(node), unit(0, 50, 50));
    // A constraint that follows a node has no point.
    expect(() => {
      follow.point = { x: 1, y: 0, z: 0 };
    }).toThrow('Constraint aim head: it follows ball, so it has no point.');
    expect(() =>
      animator.addConstraint({
        kind: 'aim',
        target: 'head',
        at: 'ball',
        point: { x: 1, y: 0, z: 0 },
      }),
    ).toThrow('Constraint aim head: give either at or point, not both.');
    expect(() => animator.addConstraint({ kind: 'aim', target: 'head', at: 'head' })).toThrow(
      'Constraint aim head: at head must not be the target or under it: it would turn with it.',
    );
    // `null` for `at` or `point` means none, as JSON writes it.
    const none = animator.addConstraint({ kind: 'aim', target: 'head', at: null, point: null });
    expect([none.at, none.point]).toEqual([null, null]);
  });

  it('is limited by maxAngle and blended by weight, from the pose every frame', () => {
    const { head: node, animator } = head();
    const aim = animator.addConstraint({
      kind: 'aim',
      target: 'head',
      point: { x: 100, y: -20, z: 0 },
      maxAngle: 0.4,
    });
    for (let i = 0; i < 3; i++) {
      animator.update(1 / 60);
      expect(angleOf(worldAxis(node), { x: 0, y: 0, z: 1 })).toBeCloseTo(0.4, 9);
    }
    aim.weight = 0.5;
    animator.evaluate();
    expect(angleOf(worldAxis(node), { x: 0, y: 0, z: 1 })).toBeCloseTo(0.2, 9);
    aim.maxAngle = Math.PI;
    animator.evaluate();
    expect(angleOf(worldAxis(node), { x: 0, y: 0, z: 1 })).toBeCloseTo(Math.PI / 4, 9);
    aim.enabled = false;
    animator.evaluate();
    expectVec(worldAxis(node), { x: 0, y: 0, z: 1 });
    aim.enabled = true;
    aim.weight = 0;
    animator.evaluate();
    expectVec(worldAxis(node), { x: 0, y: 0, z: 1 });
  });

  it('copies the point it is given and checks its parameters', () => {
    const { animator } = head();
    const point = { x: 1, y: 2, z: 3 };
    const aim = animator.addConstraint({ kind: 'aim', target: 'head', point });
    point.x = 50;
    expect(aim.point).toEqual({ x: 1, y: 2, z: 3 });
    aim.point = point;
    point.x = 7;
    expect(aim.point?.x).toBe(50);
    aim.point = null;
    expect(aim.point).toBeNull();
    expect(() => {
      aim.point = { x: Number.NaN, y: 0, z: 0 };
    }).toThrow('Constraint aim head: point must be a vector {x, y, z} of finite numbers.');
    expect(() => {
      aim.weight = 1.5;
    }).toThrow('Constraint aim head: weight must be a number from 0 to 1, got 1.5.');
    expect(() => {
      aim.maxAngle = 0;
    }).toThrow('Constraint aim head: maxAngle must be a number above 0 and at most π, got 0.');
    expect(() => {
      aim.enabled = 'no' as unknown as boolean;
    }).toThrow('Constraint aim head: enabled must be true or false, got no.');
    const bad = [
      [{ weight: -0.1 }, 'Constraint aim head: weight must be a number from 0 to 1, got -0.1.'],
      [{ weight: '0.5' }, 'Constraint aim head: weight must be a number from 0 to 1, got 0.5.'],
      [{ maxAngle: 4 }, 'Constraint aim head: maxAngle must be a number above 0'],
      [{ enabled: 1 }, 'Constraint aim head: enabled must be true or false, got 1.'],
      [{ axis: { x: 0, y: 0, z: 0 } }, 'Constraint aim head: axis must be a non-zero vector'],
      [{ point: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 } }, 'point must be a vector'],
      [{ at: 'nobody' }, 'Constraint aim head: at nobody: no node with id "nobody" in the scene.'],
      [{ maxangle: 0.5 }, 'Constraint aim head: unknown option "maxangle" (known: target, weight'],
      [{ up: { x: 0, y: 1, z: 0 } }, 'unknown option "up"'],
    ] as const;
    for (const [options, message] of bad) {
      expect(
        () => animator.addConstraint({ kind: 'aim', target: 'head', ...options } as never),
        message,
      ).toThrow(message);
    }
    expect(() => animator.addConstraint({ kind: 'aim', target: 'nobody' })).toThrow(
      'Constraint aim nobody: no node with id "nobody" in the scene.',
    );
    expect(() => animator.addConstraint({ kind: 'spin', target: 'head' } as never)).toThrow(
      'Constraint spin head: unknown kind "spin" (known: aim, lookAt, twoBoneIK, copyTransform, limitRotation).',
    );
    expect(() => animator.addConstraint(null as never)).toThrow(
      new TypeError('A constraint spec must be an object, got null.'),
    );
    expect(() => animator.addConstraint({ kind: 'aim' } as never)).toThrow(
      'Constraint aim undefined: target is required: a node id or a slot reference { slot }.',
    );
  });
});

describe('lookAt', () => {
  it('points the axis at the goal and keeps the node upright, unlike aim', () => {
    const { head: node, animator } = head();
    node.rotation.copy(rotationZ(0.6));
    const look = animator.addConstraint({
      kind: 'lookAt',
      target: 'head',
      point: { x: 40, y: -20, z: 40 },
    });
    animator.evaluate();
    expectVec(worldAxis(node), unit(1, 0, 1));
    // The up axis (−y) stays as close to world up as the axis allows: here exactly up.
    expectVec(worldAxis(node, { x: 0, y: -1, z: 0 }), { x: 0, y: -1, z: 0 });
    animator.removeConstraint(look);
    animator.addConstraint({ kind: 'aim', target: 'head', point: { x: 40, y: -20, z: 40 } });
    animator.evaluate();
    expectVec(worldAxis(node), unit(1, 0, 1));
    expect(worldAxis(node, { x: 0, y: -1, z: 0 }).y).toBeGreaterThan(-0.95);
  });

  it('takes its axes, world up and limit from the spec', () => {
    const { head: node, animator } = head();
    animator.addConstraint({
      kind: 'lookAt',
      target: 'head',
      point: { x: 0, y: -20, z: -50 },
      axis: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      worldUp: { x: 0, y: 0, z: 1 },
    });
    animator.evaluate();
    expectVec(worldAxis(node, { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 });
    expect(() =>
      animator.addConstraint({ kind: 'lookAt', target: 'head', up: { x: 0, y: 0, z: 2 } }),
    ).toThrow('Constraint lookAt head: up must not be along axis.');
    const limited = head();
    limited.animator.addConstraint({
      kind: 'lookAt',
      target: 'head',
      point: { x: 100, y: -20, z: 0 },
      maxAngle: 0.3,
    });
    limited.animator.evaluate();
    expect(quat.angleBetween(limited.head.rotation, quat.create())).toBeCloseTo(0.3, 9);
  });
});

/** An arm: `upper` at (0, −10, 0), `lower` 10 below it, the hand 8 below that. */
function arm() {
  const scene = new Scene();
  const upper = new Node({ id: 'upper', position: { x: 0, y: -10, z: 0 } });
  const lower = new Node({ id: 'lower', position: { x: 0, y: 10, z: 0 } });
  upper.add(lower);
  scene.root.add(upper);
  const animator = new Animator(scene);
  const hand = () => lower.localToWorld(vec3.create(), { x: 0, y: 8, z: 0 });
  const elbow = () => lower.localToWorld(vec3.create(), lower.pivot);
  return { scene, upper, lower, animator, hand, elbow };
}

describe('twoBoneIK', () => {
  it('puts the tip on a reachable goal and keeps the bone lengths', () => {
    const { upper, lower, animator, hand, elbow } = arm();
    lower.rotation.copy(rotationZ(0.3));
    const ik = animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 9, y: 0, z: 4 },
    });
    expect(ik.node).toBe(upper);
    animator.evaluate();
    expectVec(hand(), { x: 9, y: 0, z: 4 });
    expect(vec3.distance(elbow(), { x: 0, y: -10, z: 0 })).toBeCloseTo(10, 9);
    expect(vec3.distance(hand(), elbow())).toBeCloseTo(8, 9);
  });

  it('stretches towards an unreachable goal and stops short of the root', () => {
    const far = arm();
    far.animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 100, y: -10, z: 0 },
    });
    far.animator.evaluate();
    expectVec(far.hand(), { x: 18, y: -10, z: 0 });
    const near = arm();
    near.animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 0, y: -10, z: 0.5 },
    });
    near.animator.evaluate();
    expect(vec3.distance(near.hand(), { x: 0, y: -10, z: 0 })).toBeCloseTo(2, 6);
  });

  it('bends towards the pole, or the way the pose bends', () => {
    for (const side of [-1, 1]) {
      const { scene, animator, elbow, hand } = arm();
      scene.root.add(new Node({ id: 'pole', position: { x: side * 20, y: 0, z: 0 } }));
      animator.addConstraint({
        kind: 'twoBoneIK',
        target: 'upper',
        mid: 'lower',
        tip: { x: 0, y: 8, z: 0 },
        point: { x: 0, y: 2, z: 0 },
        pole: 'pole',
      });
      animator.evaluate();
      expectVec(hand(), { x: 0, y: 2, z: 0 });
      expect(Math.sign(elbow().x)).toBe(side);
      expect(elbow().z).toBeCloseTo(0, 9);
    }
    for (const side of [-1, 1]) {
      const { lower, animator, elbow } = arm();
      // A bend in the pose about x moves the hand along z; the elbow follows that side.
      lower.rotation.copy(quat.fromEuler(quat.create(), euler.create(side * 0.4, 0, 0)));
      animator.addConstraint({
        kind: 'twoBoneIK',
        target: 'upper',
        mid: 'lower',
        tip: { x: 0, y: 8, z: 0 },
        point: { x: 0, y: 2, z: 0 },
      });
      animator.evaluate();
      expect(Math.sign(elbow().z)).toBe(-side);
    }
  });

  it('blends with the pose by weight and checks its chain', () => {
    const { upper, lower, animator, hand } = arm();
    const ik = animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 12, y: 0, z: 0 },
      weight: 0.5,
    });
    animator.evaluate();
    const half = [quat.clone(upper.rotation), quat.clone(lower.rotation)];
    ik.weight = 1;
    animator.evaluate();
    expectVec(hand(), { x: 12, y: 0, z: 0 });
    const full = [quat.clone(upper.rotation), quat.clone(lower.rotation)];
    const rest = quat.create();
    for (let i = 0; i < 2; i++) {
      const expected = quat.slerp(quat.create(), rest, full[i] as typeof rest, 0.5);
      expect(quat.equalsRotation(half[i] as typeof rest, expected, 1e-9)).toBe(true);
    }
    expect(() =>
      animator.addConstraint({
        kind: 'twoBoneIK',
        target: 'lower',
        mid: 'upper',
        tip: { x: 0, y: 1, z: 0 },
      }),
    ).toThrow('Constraint twoBoneIK lower: mid upper must be a descendant of the target.');
    // A tip at mid's pivot makes a second bone of no length: the pose stays.
    const flatTip = animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 0, z: 0 },
      point: { x: 3, y: 3, z: 0 },
    });
    animator.removeConstraint(ik);
    animator.evaluate();
    expect(quat.equalsRotation(upper.rotation, quat.create(), 0)).toBe(true);
    animator.removeConstraint(flatTip);
    expect(() =>
      animator.addConstraint({
        kind: 'twoBoneIK',
        target: 'upper',
        mid: 'lower',
        tip: { x: 0, y: 1, z: 0 },
        pole: 'nobody',
      }),
    ).toThrow('Constraint twoBoneIK upper: pole nobody: no node with id "nobody" in the scene.');
  });
});

describe('copyTransform', () => {
  it('copies the local transform of another node, by parts and by weight', () => {
    const scene = new Scene();
    const left = new Node({ id: 'left', position: { x: 1, y: 2, z: 3 }, scale: 2 });
    left.rotation.copy(rotationZ(0.8));
    const right = new Node({ id: 'right' });
    scene.root.add(left);
    scene.root.add(right);
    const animator = new Animator(scene);
    const copy = animator.addConstraint({ kind: 'copyTransform', target: 'right', from: 'left' });
    animator.evaluate();
    expectVec(right.position, { x: 1, y: 2, z: 3 });
    expectVec(right.scale, { x: 2, y: 2, z: 2 });
    expect(quat.equalsRotation(right.rotation, left.rotation, 1e-12)).toBe(true);
    copy.weight = 0.5;
    animator.evaluate();
    expectVec(right.position, { x: 0.5, y: 1, z: 1.5 });
    expectVec(right.scale, { x: 1.5, y: 1.5, z: 1.5 });
    expect(quat.equalsRotation(right.rotation, rotationZ(0.4), 1e-12)).toBe(true);
    animator.removeConstraint(copy);
    animator.addConstraint({
      kind: 'copyTransform',
      target: 'right',
      from: 'left',
      position: false,
      scale: false,
    });
    animator.evaluate();
    expectVec(right.position, { x: 0, y: 0, z: 0 });
    expectVec(right.scale, { x: 1, y: 1, z: 1 });
    expect(quat.equalsRotation(right.rotation, left.rotation, 1e-12)).toBe(true);
    expect(() =>
      animator.addConstraint({ kind: 'copyTransform', target: 'right', from: 'right' }),
    ).toThrow('Constraint copyTransform right: a node cannot copy itself.');
  });
});

describe('limitRotation', () => {
  it('clamps Euler angles into ranges and leaves rotations inside them exactly', () => {
    const { head: node, animator } = head();
    const limit = animator.addConstraint({
      kind: 'limitRotation',
      target: 'head',
      min: { z: -0.2 },
      max: { z: 0.5, x: 0.1 },
    });
    node.rotation.copy(rotationZ(1.2));
    animator.update(0);
    // The animator owns the rotation now: it starts from the rest pose read when added.
    expect(quat.equalsRotation(node.rotation, quat.create(), 0)).toBe(true);
    const inside = quat.fromEuler(quat.create(), euler.create(0.05, 0.3, 0.4));
    animator.addLayer().play({
      duration: 1,
      loop: 'once',
      tracks: [{ target: 'head', property: 'rotation', keys: [{ time: 0, value: inside }] }],
    });
    limit.enabled = false;
    animator.evaluate();
    const plain = quat.clone(node.rotation);
    limit.enabled = true;
    animator.evaluate();
    expect(quat.equals(node.rotation, plain, 0)).toBe(true);
    animator.layers[0]?.play({
      duration: 1,
      loop: 'once',
      tracks: [
        { target: 'head', property: 'rotation', keys: [{ time: 0, value: rotationZ(1.2) }] },
      ],
    });
    animator.evaluate();
    expect(quat.equalsRotation(node.rotation, rotationZ(0.5), 1e-12)).toBe(true);
    limit.weight = 0.5;
    animator.evaluate();
    expect(quat.equalsRotation(node.rotation, rotationZ(0.85), 1e-12)).toBe(true);
    for (const [options, message] of [
      [{ min: { x: 1 }, max: { x: 0 } }, 'the x bounds have min 1 above max 0.'],
      [{ max: { x: 4 } }, 'the x bounds must be numbers within [−π, π], got [-3.14'],
      [
        { max: { y: 2 } },
        'the y bounds must be numbers within [−π/2, π/2] (the middle axis of XYZ)',
      ],
      [{ max: { z: true } }, 'the z bounds must be numbers'],
      [{ min: { X: -0.3 } }, 'min has an unknown axis "X" (known: x, y, z).'],
      [{ min: 0.3 }, 'min must be an object with x, y or z.'],
      [{ order: 'ABC' }, 'unknown Euler order "ABC".'],
    ] as const) {
      expect(() =>
        animator.addConstraint({ kind: 'limitRotation', target: 'head', ...options } as never),
      ).toThrow(message);
    }
  });
});

describe('constraints on the animator', () => {
  it('run in their explicit order, which can be changed', () => {
    const { head: node, animator } = head();
    const aim = animator.addConstraint({
      kind: 'aim',
      target: 'head',
      point: { x: 100, y: -20, z: 1 },
    });
    const limit = animator.addConstraint({
      kind: 'limitRotation',
      target: 'head',
      max: { y: 0.3 },
    });
    expect(animator.constraints).toEqual([aim, limit]);
    animator.evaluate();
    expect(angleOf(worldAxis(node), { x: 0, y: 0, z: 1 })).toBeCloseTo(0.3, 9);
    animator.moveConstraint(limit, 0);
    expect(animator.constraints).toEqual([limit, aim]);
    animator.evaluate();
    expect(angleOf(worldAxis(node), { x: 0, y: 0, z: 1 })).toBeGreaterThan(1.5);
    const first = animator.addConstraint({ kind: 'limitRotation', target: 'head' }, 0);
    expect(animator.constraints[0]).toBe(first);
    expect(() => animator.addConstraint({ kind: 'limitRotation', target: 'head' }, 9)).toThrow(
      'Constraint index must be an integer from 0 to 3, got 9.',
    );
    expect(() => animator.moveConstraint(first, 3)).toThrow(RangeError);
    animator.removeConstraint(first);
    animator.removeConstraint(first);
    expect(animator.constraints).toEqual([limit, aim]);
    expect(() => animator.moveConstraint(first, 0)).toThrow(
      'The constraint is not on this animator.',
    );
  });

  it('address rig slots and skip destroyed nodes', () => {
    const { scene, body, head: node } = head();
    const rig = new Rig(body, { head: 'head', body: 'body' });
    const animator = new Animator(scene, { rig });
    const aim = animator.addConstraint({
      kind: 'aim',
      target: { slot: 'head' },
      point: { x: 50, y: -20, z: 50 },
    });
    expect(aim.target).toEqual({ slot: 'head' });
    animator.evaluate();
    expectVec(worldAxis(node), unit(1, 0, 1));
    expect(() => animator.addConstraint({ kind: 'aim', target: { slot: 'tail' } })).toThrow(
      'Constraint aim [tail]: the rig has no slot "tail" (slots: head, body).',
    );
    node.destroy();
    expect(() => animator.evaluate()).not.toThrow();
  });

  it('come after the layers and before springs, and seek exactly', () => {
    const { head: node, animator } = head();
    const ear = new Node({ id: 'ear', position: { x: 0, y: -10, z: 0 } });
    node.add(ear);
    animator.addLayer().play({
      duration: 2,
      loop: 'loop',
      tracks: [
        {
          target: 'head',
          property: 'rotation',
          keys: [
            { time: 0, value: rotationZ(0) },
            { time: 1, value: rotationZ(0.5) },
            { time: 2, value: rotationZ(0) },
          ],
        },
      ],
    });
    animator.addConstraint({ kind: 'aim', target: 'head', point: { x: 20, y: -20, z: 30 } });
    animator.addSpring({ target: 'ear', tip: { x: 0, y: -10, z: 0 } });
    for (let i = 0; i < 30; i++) animator.update(1 / 60);
    const played = quat.clone(node.rotation);
    expectVec(worldAxis(node), unit(20, 0, 30));
    // The spring turned the ear after the aim had turned the head: the ear hangs back.
    expect(quat.angleBetween(ear.rotation, quat.create())).toBeGreaterThan(0.01);
    // Constraints keep no state: evaluating the same layer time gives the same head.
    animator.springsEnabled = false;
    animator.evaluate();
    expect(quat.equalsRotation(node.rotation, played, 1e-12)).toBe(true);
    expect(quat.equalsRotation(ear.rotation, quat.create(), 0)).toBe(true);
  });
});

describe('Camera.unproject', () => {
  it('inverts project at a given depth in both projections', () => {
    for (const projection of ['orthographic', 'perspective'] as const) {
      const camera = new Camera({
        projection,
        zoom: 1.5,
        distance: 400,
        position: { x: 10, y: -5, z: 3 },
        rotation: euler.create(0.2, -0.4, 0.1),
      });
      const world = { x: 12, y: -30, z: 17 };
      const projected = createProjectedPoint();
      expect(camera.project(projected, world)).toBe(true);
      const back = camera.unproject(vec3.create(), projected.x, projected.y, projected.depth);
      expectVec(back ?? vec3.create(), world);
    }
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    const out = vec3.create(7, 7, 7);
    expect(perspective.unproject(out, 0, 0, 100)).toBeNull();
    expect(out).toEqual({ x: 7, y: 7, z: 7 });
  });
});

describe('constraints in depth', () => {
  it('lookAt corrects the roll for a goal above and to the side, also under a turned parent', () => {
    for (const turned of [false, true]) {
      const { body, head: node, animator } = head();
      if (turned) {
        body.rotation.copy(quat.fromEuler(quat.create(), euler.create(0.3, -0.5, 0.2)));
        body.scale.set(2, 2, 2);
      }
      const target = { x: 40, y: -90, z: 40 };
      animator.addConstraint({ kind: 'lookAt', target: 'head', point: target });
      animator.evaluate();
      const center = node.localToWorld(vec3.create(), node.pivot);
      const f = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), target, center));
      expectVec(worldAxis(node), f);
      // No roll: the up axis has nothing along the horizontal right vector, and points up.
      const right = vec3.normalize(
        vec3.create(),
        vec3.cross(vec3.create(), f, { x: 0, y: -1, z: 0 }),
      );
      const up = worldAxis(node, { x: 0, y: -1, z: 0 });
      expect(vec3.dot(up, right)).toBeCloseTo(0, 9);
      expect(up.y).toBeLessThan(0);
    }
  });

  it('lookAt follows worldUp, and limits and weighs its turn from the pose', () => {
    const { head: node, animator } = head();
    const look = animator.addConstraint({
      kind: 'lookAt',
      target: 'head',
      point: { x: 0, y: -20, z: 100 },
      worldUp: { x: 1, y: 0, z: 0 },
    });
    animator.evaluate();
    expectVec(worldAxis(node), { x: 0, y: 0, z: 1 });
    expectVec(worldAxis(node, { x: 0, y: -1, z: 0 }), { x: 1, y: 0, z: 0 });
    animator.removeConstraint(look);
    const posed = head();
    posed.head.rotation.copy(rotationZ(0.6));
    const limited = posed.animator.addConstraint({
      kind: 'lookAt',
      target: 'head',
      point: { x: 0, y: -20, z: 100 },
      maxAngle: 0.3,
    });
    posed.animator.evaluate();
    expect(quat.angleBetween(posed.head.rotation, rotationZ(0.6))).toBeCloseTo(0.3, 9);
    limited.maxAngle = Math.PI;
    limited.weight = 0.5;
    posed.animator.evaluate();
    expect(quat.angleBetween(posed.head.rotation, rotationZ(0.6))).toBeCloseTo(0.3, 9);
    expect(() => {
      limited.maxAngle = 0;
    }).toThrow(RangeError);
  });

  it('aim uses the axis of its spec', () => {
    const { head: node, animator } = head();
    animator.addConstraint({
      kind: 'aim',
      target: 'head',
      axis: { x: 2, y: 0, z: 0 },
      point: { x: 0, y: -20, z: -30 },
    });
    animator.evaluate();
    expectVec(worldAxis(node, { x: 1, y: 0, z: 0 }), { x: 0, y: 0, z: -1 });
  });

  it('a constraint whose goal or pole node is gone shows the pose; the others run on', () => {
    const { scene, head: node, animator } = head();
    const ball = new Node({ id: 'ball', position: { x: 50, y: -20, z: 0 } });
    scene.root.add(ball);
    animator.addConstraint({ kind: 'aim', target: 'head', at: 'ball' });
    animator.evaluate();
    expectVec(worldAxis(node), { x: 1, y: 0, z: 0 });
    ball.destroy();
    animator.evaluate();
    expectVec(worldAxis(node), { x: 0, y: 0, z: 1 });
    const limb = arm();
    const pole = new Node({ id: 'pole', position: { x: 20, y: 0, z: 0 } });
    limb.scene.root.add(pole);
    const other = new Node({ id: 'other' });
    limb.scene.root.add(other);
    limb.animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 0, y: 2, z: 0 },
      pole: 'pole',
    });
    limb.animator.addConstraint({ kind: 'aim', target: 'other', point: { x: 10, y: 0, z: 0 } });
    pole.destroy();
    limb.animator.evaluate();
    expectVec(limb.hand(), { x: 0, y: 8, z: 0 });
    expectVec(worldAxis(other), { x: 1, y: 0, z: 0 });
  });

  it('a detached node pauses the constraint until it is back', () => {
    const { body, head: node, animator } = head();
    animator.addConstraint({ kind: 'aim', target: 'head', point: { x: 50, y: -20, z: 0 } });
    node.removeFromParent();
    animator.evaluate();
    expectVec(worldAxis(node), { x: 0, y: 0, z: 1 });
    body.add(node);
    animator.evaluate();
    expectVec(worldAxis(node), { x: 1, y: 0, z: 0 });
  });

  it('moves to the node that replaced a destroyed one, by id or by slot, and owns it', () => {
    const { scene, body, head: node } = head();
    const rig = new Rig(body, { head: 'head' });
    const animator = new Animator(scene, { rig });
    const byId = animator.addConstraint({
      kind: 'aim',
      target: 'head',
      point: { x: 50, y: -20, z: 0 },
    });
    const bySlot = animator.addConstraint({ kind: 'lookAt', target: { slot: 'head' } });
    node.destroy();
    animator.evaluate();
    expect(byId.node).toBe(node);
    const fresh = new Node({ id: 'head', position: { x: 0, y: -20, z: 0 } });
    fresh.rotation.copy(rotationZ(0.4));
    body.add(fresh);
    animator.evaluate();
    expect(byId.node).toBe(fresh);
    expect(bySlot.node).toBe(fresh);
    expectVec(worldAxis(fresh), { x: 1, y: 0, z: 0 });
    // The new node's rotation is owned now: without the constraint it returns to its rest.
    byId.enabled = false;
    animator.evaluate();
    expect(quat.equalsRotation(fresh.rotation, rotationZ(0.4), 1e-12)).toBe(true);
  });

  it('two-bone IK owns the mid bone too, so nothing builds up', () => {
    const { lower, animator } = arm();
    const ik = animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 9, y: 0, z: 4 },
      weight: 0.5,
    });
    animator.update(1 / 60);
    const first = quat.clone(lower.rotation);
    for (let i = 0; i < 3; i++) {
      animator.update(1 / 60);
      expect(quat.equals(lower.rotation, first, 1e-12)).toBe(true);
    }
    expect(animator.removeConstraint(ik)).toBe(true);
    expect(animator.removeConstraint(ik)).toBe(false);
    animator.evaluate();
    expect(quat.equalsRotation(lower.rotation, quat.create(), 0)).toBe(true);
  });

  it('a straight limb without a pole bends in the plane of the limb and the goal', () => {
    const { animator, elbow, hand } = arm();
    animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 6, y: 0, z: 0 },
    });
    animator.evaluate();
    expectVec(hand(), { x: 6, y: 0, z: 0 });
    expect(elbow().z).toBeCloseTo(0, 9);
  });

  it('takes the pole relative to the root, and clamps a near goal to the shorter reach', () => {
    const { upper, scene, animator, elbow, hand } = arm();
    upper.position.set(30, -10, 0);
    scene.root.add(new Node({ id: 'pole', position: { x: 25, y: 0, z: 0 } }));
    animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 30, y: 2, z: 0 },
      pole: 'pole',
    });
    animator.evaluate();
    expectVec(hand(), { x: 30, y: 2, z: 0 });
    expect(elbow().x).toBeLessThan(30);
    const near = arm();
    near.lower.rotation.copy(rotationZ(0.5));
    near.animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 0.3, y: -10, z: 0.3 },
    });
    near.animator.evaluate();
    expect(vec3.distance(near.hand(), { x: 0, y: -10, z: 0 })).toBeCloseTo(2, 6);
    expect(vec3.distance(near.elbow(), { x: 0, y: -10, z: 0 })).toBeCloseTo(10, 9);
    expect(vec3.distance(near.hand(), near.elbow())).toBeCloseTo(8, 9);
  });

  it('leaves the pose alone for a bone of no length, and rejects chain nodes as at or pole', () => {
    const { scene, animator } = arm();
    const lower = scene.getById('lower') as Node;
    const flat = new Node({ id: 'flat' });
    lower.add(flat);
    const pose = quat.clone(lower.rotation);
    animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'lower',
      mid: 'flat',
      tip: { x: 0, y: 1, z: 0 },
      point: { x: 5, y: 5, z: 0 },
    });
    animator.evaluate();
    expect(quat.equals(lower.rotation, pose, 0)).toBe(true);
    // A parent of scale 0 squashes the bones, but the chain is still valid.
    const squashed = arm();
    squashed.upper.scale.set(0, 0, 0);
    expect(() =>
      squashed.animator.addConstraint({
        kind: 'twoBoneIK',
        target: 'upper',
        mid: 'lower',
        tip: { x: 0, y: 8, z: 0 },
        point: { x: 5, y: 5, z: 0 },
      }),
    ).not.toThrow();
    expect(() => squashed.animator.evaluate()).not.toThrow();
    for (const [options, message] of [
      [{ target: null }, 'Constraint twoBoneIK null: target is required: a node id or a slot'],
      [{ mid: null }, 'Constraint twoBoneIK upper: mid is required: a node id or a slot'],
      [{ target: 5 }, 'Constraint twoBoneIK 5: target is required'],
    ] as const) {
      expect(() =>
        animator.addConstraint({
          kind: 'twoBoneIK',
          target: 'upper',
          mid: 'lower',
          tip: { x: 0, y: 8, z: 0 },
          ...options,
        } as never),
      ).toThrow(message);
    }
    expect(() =>
      animator.addConstraint({ kind: 'copyTransform', target: 'upper', from: null } as never),
    ).toThrow('Constraint copyTransform upper: from is required');
    expect(() =>
      animator.addConstraint({
        kind: 'twoBoneIK',
        target: 'upper',
        mid: 'lower',
        tip: { x: 0, y: 8, z: 0 },
        pole: 'lower',
      }),
    ).toThrow(
      'Constraint twoBoneIK upper: pole lower must not be the target or under it: it would turn with it.',
    );
    expect(() =>
      animator.addConstraint({
        kind: 'twoBoneIK',
        target: 'upper',
        mid: 'lower',
        at: 'upper',
        tip: { x: 0, y: 8, z: 0 },
      }),
    ).toThrow('at upper must not be the target or under it');
    expect(() =>
      animator.addConstraint({ kind: 'twoBoneIK', target: 'upper', mid: 'lower' } as never),
    ).toThrow("Constraint twoBoneIK upper: tip is required: a point in mid's coordinates.");
  });

  it('copyTransform copies each part on its own', () => {
    const scene = new Scene();
    const left = new Node({ id: 'left', position: { x: 1, y: 2, z: 3 }, scale: 2 });
    left.rotation.copy(rotationZ(0.8));
    const right = new Node({ id: 'right' });
    scene.root.add(left);
    scene.root.add(right);
    for (const part of ['position', 'rotation', 'scale'] as const) {
      const animator = new Animator(scene);
      animator.addConstraint({
        kind: 'copyTransform',
        target: 'right',
        from: 'left',
        [part]: false,
      });
      animator.evaluate();
      expect(vec3.equals(right.position, left.position, 0), part).toBe(part !== 'position');
      expect(quat.equalsRotation(right.rotation, left.rotation, 1e-12), part).toBe(
        part !== 'rotation',
      );
      expect(vec3.equals(right.scale, left.scale, 0), part).toBe(part !== 'scale');
      right.position.set(0, 0, 0);
      right.rotation.copy(quat.create());
      right.scale.set(1, 1, 1);
    }
    expect(() =>
      new Animator(scene).addConstraint({
        kind: 'copyTransform',
        target: 'right',
        from: 'left',
        position: false,
        rotation: false,
        scale: false,
      }),
    ).toThrow('it copies nothing');
    expect(() =>
      new Animator(scene).addConstraint({
        kind: 'copyTransform',
        target: 'right',
        from: 'left',
        position: 'false',
      } as never),
    ).toThrow('position must be true or false, got false.');
  });

  it('limitRotation clamps the lower bound, the x axis and in other orders', () => {
    const { head: node, animator } = head();
    const layer = animator.addLayer();
    const play = (q: Readonly<{ x: number; y: number; z: number; w: number }>) =>
      layer.play({
        duration: 1,
        loop: 'once',
        tracks: [{ target: 'head', property: 'rotation', keys: [{ time: 0, value: q }] }],
      });
    const limit = animator.addConstraint({
      kind: 'limitRotation',
      target: 'head',
      min: { z: -0.2 },
      max: { x: 0.1 },
    });
    play(rotationZ(-0.8));
    animator.evaluate();
    expect(quat.equalsRotation(node.rotation, rotationZ(-0.2), 1e-12)).toBe(true);
    play(quat.fromEuler(quat.create(), euler.create(0.4, 0, 0)));
    animator.evaluate();
    expect(
      quat.equalsRotation(
        node.rotation,
        quat.fromEuler(quat.create(), euler.create(0.1, 0, 0)),
        1e-12,
      ),
    ).toBe(true);
    animator.removeConstraint(limit);
    animator.addConstraint({
      kind: 'limitRotation',
      target: 'head',
      max: { z: 0.2 },
      order: 'ZYX',
    });
    const mixed = euler.create(0.3, 0.4, 0.6, 'ZYX');
    play(quat.fromEuler(quat.create(), mixed));
    animator.evaluate();
    const expected = quat.fromEuler(quat.create(), euler.create(0.3, 0.4, 0.2, 'ZYX'));
    expect(quat.equalsRotation(node.rotation, expected, 1e-12)).toBe(true);
  });

  it('limitRotation does not jump for a pose past the middle axis range', () => {
    const { head: node, animator } = head();
    animator.addConstraint({
      kind: 'limitRotation',
      target: 'head',
      min: { x: -1, y: -1.5 },
      max: { x: 1, y: 1.5 },
    });
    const pose = quat.fromEuler(quat.create(), euler.create(0, 1.8, 0));
    animator.addLayer().play({
      duration: 1,
      loop: 'once',
      tracks: [{ target: 'head', property: 'rotation', keys: [{ time: 0, value: pose }] }],
    });
    animator.evaluate();
    // The nearest allowed rotation, 0.3 away, not the 2.14 of clamping its other Euler form.
    expect(quat.angleBetween(node.rotation, pose)).toBeCloseTo(0.3, 9);
    const nearest = quat.fromEuler(quat.create(), euler.create(0, 1.5, 0));
    expect(quat.equalsRotation(node.rotation, nearest, 1e-9)).toBe(true);
  });

  it('turns back into specs that create the same constraints', () => {
    const { scene, animator } = arm();
    scene.root.add(new Node({ id: 'pole', position: { x: 20, y: 0, z: 0 } }));
    scene.root.add(new Node({ id: 'ball' }));
    const specs = [
      { kind: 'aim', target: 'upper', point: { x: 1, y: 2, z: 3 }, maxAngle: 0.5, enabled: false },
      { kind: 'lookAt', target: 'upper', at: 'ball', up: { x: 1, y: 0, z: 0 }, weight: 0.25 },
      { kind: 'twoBoneIK', target: 'upper', mid: 'lower', tip: { x: 0, y: 8, z: 0 }, pole: 'pole' },
      { kind: 'copyTransform', target: 'ball', from: 'pole', scale: false },
      { kind: 'limitRotation', target: 'lower', min: { z: -1 }, max: { x: 0.5 }, order: 'YXZ' },
    ] as const;
    for (const spec of specs) {
      const constraint = animator.addConstraint(spec);
      const saved = constraint.toSpec();
      expect(saved.kind).toBe(spec.kind);
      expect(animator.addConstraint(saved).toSpec()).toEqual(saved);
      expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    }
    expect(animator.constraints[0]?.toSpec()).toEqual({
      kind: 'aim',
      target: 'upper',
      weight: 1,
      enabled: false,
      point: { x: 1, y: 2, z: 3 },
      axis: { x: 0, y: 0, z: 1 },
      maxAngle: 0.5,
    });
  });

  it('checks indices, and narrows by kind', () => {
    const { animator } = head();
    expect(() => animator.addConstraint({ kind: 'limitRotation', target: 'head' }, 0.5)).toThrow(
      RangeError,
    );
    const aim = animator.addConstraint({ kind: 'aim', target: 'head' });
    expect(() => animator.moveConstraint(aim, 0.5)).toThrow(RangeError);
    const found = animator.constraints[0];
    if (found?.kind === 'aim') expect(found.maxAngle).toBe(Math.PI);
    expect(Object.isFrozen(aim.axis)).toBe(true);
  });
});

describe('constraints after the full review', () => {
  it('a slot rebound alone does not move a live constraint; a rig change alone rebinds a lost one', () => {
    const { scene, body, head: node } = head();
    const other = new Node({ id: 'other', position: { x: 0, y: -20, z: 0 } });
    body.add(other);
    const rig = new Rig(body, { head: 'head' });
    const animator = new Animator(scene, { rig });
    const aim = animator.addConstraint({
      kind: 'aim',
      target: { slot: 'head' },
      point: { x: 50, y: -20, z: 0 },
    });
    rig.setSlot('head', 'other');
    animator.evaluate();
    expect(aim.node).toBe(node);
    expect(quat.equalsRotation(other.rotation, quat.create(), 0)).toBe(true);
    rig.setSlot('head', 'head');
    node.destroy();
    animator.evaluate();
    expect(aim.problem).toMatch(/^node "head" is destroyed or out of the scene, and/);
    // Only the slots change now: `other` was there all along.
    rig.setSlot('head', 'other');
    animator.evaluate();
    expect(aim.node).toBe(other);
    expect(aim.problem).toBeNull();
    expectVec(worldAxis(other), { x: 1, y: 0, z: 0 });
  });

  it('a broken chain does nothing, says why, and comes back when its slot names a good mid', () => {
    const { scene, upper, lower, animator } = arm();
    const rigged = new Animator(scene, { rig: new Rig(scene.root, { mid: 'lower' }) });
    const ik = rigged.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: { slot: 'mid' },
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 9, y: 0, z: 4 },
    });
    expect(animator).toBeDefined();
    scene.root.add(lower);
    rigged.evaluate();
    expect(quat.equalsRotation(upper.rotation, quat.create(), 0)).toBe(true);
    expect(ik.problem).toBe('mid "lower" has left the subtree of the target "upper".');
    const fore = new Node({ id: 'fore', position: { x: 0, y: 10, z: 0 } });
    upper.add(fore);
    rigged.rig?.setSlot('mid', 'fore');
    rigged.evaluate();
    expect(ik.midNode).toBe(fore);
    expect(ik.problem).toBeNull();
    expectVec(fore.localToWorld(vec3.create(), { x: 0, y: 8, z: 0 }), { x: 9, y: 0, z: 4 });
  });

  it('a node moved into another scene pauses the constraint', () => {
    const { head: node, animator } = head();
    animator.addConstraint({ kind: 'aim', target: 'head', point: { x: 50, y: -20, z: 0 } });
    new Scene().root.add(node);
    animator.evaluate();
    expect(quat.equalsRotation(node.rotation, quat.create(), 0)).toBe(true);
  });

  it('two-bone IK reaches the goal under non-uniform scale above the chain', () => {
    const { scene, upper, animator, hand } = arm();
    const holder = new Node({ id: 'holder', scale: { x: 1, y: 2, z: 0.5 } });
    holder.rotation.copy(rotationZ(0.3));
    scene.root.add(holder);
    holder.add(upper);
    const goalPoint = { x: 6, y: 4, z: 2 };
    animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: goalPoint,
    });
    animator.evaluate();
    expectVec(hand(), goalPoint);
  });

  it('a pole on the line to the goal falls back to the bend of the pose', () => {
    const { scene, lower, animator, elbow, hand } = arm();
    lower.rotation.copy(quat.fromEuler(quat.create(), euler.create(0.4, 0, 0)));
    scene.root.add(new Node({ id: 'pole', position: { x: 0, y: 30, z: 0 } }));
    animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 0, y: 2, z: 0 },
      pole: 'pole',
    });
    animator.evaluate();
    expectVec(hand(), { x: 0, y: 2, z: 0 });
    expect(vec3.distance(elbow(), { x: 0, y: -10, z: 0 })).toBeCloseTo(10, 9);
    expect(Math.sign(elbow().z)).toBe(-1);
  });

  it('lookAt leaves the pose under a parent of scale 0, and stays finite along worldUp', () => {
    const turned = head();
    turned.body.rotation.copy(rotationZ(0.5));
    turned.animator.addConstraint({ kind: 'lookAt', target: 'head', point: { x: 9, y: 3, z: 9 } });
    turned.animator.evaluate();
    const { body, head: node, animator } = head();
    body.scale.set(0, 0, 0);
    animator.addConstraint({ kind: 'lookAt', target: 'head', point: { x: 10, y: 0, z: 10 } });
    animator.evaluate();
    expect(quat.equalsRotation(node.rotation, quat.create(), 0)).toBe(true);
    const up = head();
    up.animator.addConstraint({ kind: 'lookAt', target: 'head', point: { x: 0, y: -120, z: 0 } });
    up.animator.evaluate();
    for (const value of [up.head.rotation.x, up.head.rotation.y, up.head.rotation.z]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expectVec(worldAxis(up.head), { x: 0, y: -1, z: 0 });
  });

  it('limitRotation leaves every rotation inside its ranges exactly as it was', () => {
    const { head: node, animator } = head();
    const limit = animator.addConstraint({
      kind: 'limitRotation',
      target: 'head',
      min: { x: -3, y: -1.5, z: -3 },
      max: { x: 3, y: 1.5, z: 3 },
    });
    const layer = animator.addLayer();
    let seed = 7;
    const next = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 200; i++) {
      const pose = euler.create((next() * 2 - 1) * 3, (next() * 2 - 1) * 1.5, (next() * 2 - 1) * 3);
      layer.play({
        duration: 1,
        loop: 'once',
        tracks: [
          {
            target: 'head',
            property: 'rotation',
            keys: [{ time: 0, value: quat.fromEuler(quat.create(), pose) }],
          },
        ],
      });
      limit.enabled = false;
      animator.evaluate();
      const plain = quat.clone(node.rotation);
      limit.enabled = true;
      animator.evaluate();
      expect(quat.equals(node.rotation, plain, 0)).toBe(true);
    }
  });

  it('limitRotation moves smoothly when the pose crosses ±π outside its range', () => {
    const { head: node, animator } = head();
    animator.addConstraint({ kind: 'limitRotation', target: 'head', min: { x: 0 }, max: { x: 2 } });
    const layer = animator.addLayer();
    let previous: ReturnType<typeof quat.create> | null = null;
    // Across π the result stays at the bound; much further out another allowed rotation
    // becomes the nearest, as with any limit that is not convex.
    for (let x = 2.9; x <= 3.32; x += 0.02) {
      layer.play({
        duration: 1,
        loop: 'once',
        tracks: [
          {
            target: 'head',
            property: 'rotation',
            keys: [{ time: 0, value: quat.fromEuler(quat.create(), euler.create(x, 0.2, 0.1)) }],
          },
        ],
      });
      animator.evaluate();
      if (previous) expect(quat.angleBetween(node.rotation, previous)).toBeLessThan(0.05);
      previous = quat.clone(node.rotation);
    }
  });

  it('keeps its spec apart from run-time changes and from the caller', () => {
    const { animator } = arm();
    const tip = { x: 0, y: 8, z: 0 };
    const point = { x: 9, y: 0, z: 4 };
    const ik = animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip,
      point,
    });
    tip.y = 99;
    point.x = 99;
    expect(ik.tip.y).toBe(8);
    expect(ik.point?.x).toBe(9);
    const before = ik.point;
    ik.point = { x: 1, y: 1, z: 1 };
    ik.weight = 0.5;
    expect(before?.x).toBe(9);
    expect(Object.isFrozen(ik.point)).toBe(true);
    const saved = ik.toSpec();
    expect(saved.point).toEqual({ x: 9, y: 0, z: 4 });
    expect(saved.weight).toBe(1);
    (saved.point as { x: number }).x = 5;
    expect(ik.toSpec().point).toEqual({ x: 9, y: 0, z: 4 });
    const aim = animator.addConstraint({
      kind: 'aim',
      target: 'upper',
      axis: { x: 3, y: 0, z: 0 },
    });
    expect(aim.axis).toEqual({ x: 1, y: 0, z: 0 });
    expect(Object.isFrozen(aim.axis)).toBe(true);
  });

  it('replaces a constraint with an edited spec in place, or changes nothing', () => {
    const { head: node, animator } = head();
    const first = animator.addConstraint({ kind: 'limitRotation', target: 'head' });
    const aim = animator.addConstraint({
      kind: 'aim',
      target: 'head',
      point: { x: 50, y: -20, z: 0 },
    });
    const last = animator.addConstraint({ kind: 'limitRotation', target: 'head' });
    const edited = animator.replaceConstraint(aim, { ...aim.toSpec(), maxAngle: 0.25 });
    expect(animator.constraints).toEqual([first, edited, last]);
    expect(edited.maxAngle).toBe(0.25);
    animator.evaluate();
    expect(angleOf(worldAxis(node), { x: 0, y: 0, z: 1 })).toBeCloseTo(0.25, 9);
    expect(() => animator.replaceConstraint(edited, { ...edited.toSpec(), maxAngle: 9 })).toThrow(
      'maxAngle must be a number above 0',
    );
    expect(animator.constraints).toEqual([first, edited, last]);
    expect(() => animator.replaceConstraint(aim, aim.toSpec())).toThrow(
      'The constraint is not on this animator.',
    );
  });

  it('checks goals, poles and vectors from loose data', () => {
    const { scene, animator } = arm();
    const nose = new Node({ id: 'nose' });
    scene.getById('lower')?.add(nose);
    const ik = (options: object) =>
      animator.addConstraint({
        kind: 'twoBoneIK',
        target: 'upper',
        mid: 'lower',
        tip: { x: 0, y: 8, z: 0 },
        ...options,
      } as never);
    for (const [options, message] of [
      [{ at: 'nose' }, 'at nose must not be the target or under it: it would turn with it.'],
      [{ pole: 'upper' }, 'pole upper must not be the target or under it'],
      [
        { at: 5 },
        'Constraint twoBoneIK upper: at must be a node id or a slot reference { slot }, got 5.',
      ],
      [{ pole: {} }, 'pole must be a node id or a slot reference { slot }, got {}.'],
    ] as const) {
      expect(() => ik(options), message).toThrow(message);
    }
    expect(() =>
      animator.addConstraint({ kind: 'aim', target: 'upper', axis: { x: 1e200, y: 0, z: 0 } }),
    ).toThrow('axis must be a non-zero vector');
    const loose = animator.addConstraint({
      kind: 'aim',
      target: 'upper',
      weight: null,
      enabled: null,
      maxAngle: null,
      axis: null,
    } as unknown as AimSpec);
    expect([loose.weight, loose.enabled, loose.maxAngle]).toEqual([1, true, Math.PI]);
  });

  it('springs and constraints both say whether they were removed; unproject refuses NaN', () => {
    const { animator } = head();
    const spring = animator.addSpring({ target: 'head', tip: { x: 0, y: -5, z: 0 } });
    expect(animator.removeSpring(spring)).toBe(true);
    expect(animator.removeSpring(spring)).toBe(false);
    const camera = new Camera();
    const out = vec3.create(1, 2, 3);
    expect(camera.unproject(out, Number.NaN, 0, 0)).toBeNull();
    expect(camera.unproject(out, 0, 0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(out).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('a goal or pole moved under the target stops the constraint and says why', () => {
    const { scene, head: node, animator } = head();
    const ball = new Node({ id: 'ball', position: { x: 50, y: -20, z: 0 } });
    scene.root.add(ball);
    const aim = animator.addConstraint({ kind: 'aim', target: 'head', at: 'ball' });
    node.add(ball);
    animator.evaluate();
    expect(quat.equalsRotation(node.rotation, quat.create(), 0)).toBe(true);
    expect(aim.problem).toBe('at "ball" is the target "head" or under it: it would turn with it.');
    scene.root.add(ball);
    animator.evaluate();
    expect(aim.problem).toBeNull();
    expectVec(worldAxis(node), { x: 1, y: 0, z: 0 });
    const limb = arm();
    const pole = new Node({ id: 'pole', position: { x: 20, y: 0, z: 0 } });
    limb.scene.root.add(pole);
    const ik = limb.animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 0, y: 2, z: 0 },
      pole: 'pole',
    });
    limb.upper.add(pole);
    limb.animator.evaluate();
    expectVec(limb.hand(), { x: 0, y: 8, z: 0 });
    expect(ik.problem).toBe(
      'pole "pole" is the target "upper" or under it: it would turn with it.',
    );
  });

  it('forgets an old failure once the constraint works again', () => {
    const { body, head: node, animator } = head();
    const aim = animator.addConstraint({
      kind: 'aim',
      target: 'head',
      point: { x: 50, y: -20, z: 0 },
    });
    node.removeFromParent();
    animator.evaluate();
    expect(aim.problem).toMatch(/and no node with id "head" in the scene\.$/);
    body.add(node);
    animator.evaluate();
    expect(aim.problem).toBeNull();
    node.removeFromParent();
    expect(aim.problem).toBe('node "head" is destroyed or out of the scene.');
  });
});
