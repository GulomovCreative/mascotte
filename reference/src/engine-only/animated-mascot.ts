import {
  type AimConstraint,
  type Animator,
  type BehaviorSet,
  Camera,
  type Clip,
  Node,
  PathShape,
  Rig,
  Sphere,
} from '@mascotte/engine';
import { euler, quat } from '@mascotte/math';

/*
 * The example mascot: it waves (a clip), breathes and sways (additive behaviors), blinks at
 * random (behaviors on a layer masked to the head), now and then tilts its head, and its ears
 * swing after the head on springs. Its head can follow a point (the pointer, in the
 * playground) through an `aim` constraint. The layers depend only on time and constraints
 * keep no state, so with springs off and the same gaze point and weight, setting the layer
 * times gives the same frame as playing up to them.
 *
 * Its skeleton (the root, body, head, shoulders and ears) is marked as bones, and its rig
 * binds slots to its nodes; every clip, behavior, mask, constraint and spring addresses
 * slots, not node ids.
 */

function rotation(x: number, y: number, z: number) {
  const q = quat.fromEuler(quat.create(), euler.create(x, y, z));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** A point on a sphere of radius `radius` in direction (x, y) on the front side, at `distance`. */
function onSphere(x: number, y: number, radius: number, distance: number) {
  const z = Math.sqrt(Math.max(0, radius * radius - x * x - y * y));
  const length = Math.hypot(x, y, z) || 1;
  return { x: (x / length) * distance, y: (y / length) * distance, z: (z / length) * distance };
}

const radius = 40;

/** Where an ear (side −1 left, 1 right) grows from the head, and its tip from there. */
function earBase(side: number) {
  return { x: side * 20, y: -20, z: 0 };
}
function earTip(side: number) {
  return { x: side * 12, y: -32, z: 0 };
}

/**
 * Builds the mascot: `head` with `eyes`, closed `lids` and ears `ear-left` and `ear-right`,
 * `body`, and arms on `shoulder-left` and `shoulder-right`; and its rig with the slots
 * `root`, `body`, `head`, `eyes`, `lids`, `ear.L`, `ear.R`, `arm.L` and `arm.R`.
 */
function build(): { root: Node; camera: Camera; rig: Rig } {
  const root = new Node({
    id: 'mascot',
    bone: true,
    position: { x: 0, y: -22, z: 0 },
    rotation: euler.create(-0.1, 0.35, 0),
  });
  const camera = new Camera({ zoom: 1.4 });
  const head = new Sphere({
    id: 'head',
    bone: true,
    diameter: radius * 2,
    style: { color: '#f6a623', stroke: 0 },
  });
  const eyes = new Node({ id: 'eyes' });
  const lids = new Node({ id: 'lids', visible: false });
  for (const side of [-1, 1]) {
    // An ear on its own node at its base, so a spring can swing it.
    const ear = new Node({
      id: side < 0 ? 'ear-left' : 'ear-right',
      bone: true,
      position: earBase(side),
    });
    ear.add(
      new PathShape({
        path: [
          { type: 'move', point: { x: 0, y: 0, z: 0 } },
          { type: 'line', point: earTip(side) },
        ],
        style: { stroke: 16, color: '#e0861a' },
      }),
    );
    head.add(ear);
    eyes.add(
      new Sphere({
        diameter: 14,
        position: onSphere(side * 14, -6, radius, radius - 2),
        style: { color: '#ffffff', stroke: 0 },
      }),
    );
    eyes.add(
      new Sphere({
        diameter: 6,
        position: onSphere(side * 14, -6, radius, radius + 3),
        style: { color: '#222222', stroke: 0 },
      }),
    );
    // A closed eye: a short line on the head surface.
    lids.add(
      new PathShape({
        path: [
          { type: 'move', point: onSphere(side * 14 - 6, -5, radius, radius + 2) },
          { type: 'line', point: onSphere(side * 14 + 6, -5, radius, radius + 2) },
        ],
        closed: false,
        style: { stroke: 3, color: '#5a2a0c' },
      }),
    );
  }
  head.add(eyes);
  head.add(lids);
  const mouth = [];
  for (let i = 0; i <= 8; i++) {
    const x = -9 + (18 * i) / 8;
    const y = 12 + (1 - (x / 9) ** 2) * 5;
    mouth.push({
      type: i === 0 ? ('move' as const) : ('line' as const),
      point: onSphere(x, y, radius, radius + 2.5),
    });
  }
  head.add(new PathShape({ path: mouth, closed: false, style: { stroke: 4, color: '#8a3b12' } }));
  root.add(head);
  const body = new Sphere({
    id: 'body',
    bone: true,
    diameter: 56,
    position: { x: 0, y: 72, z: 0 },
    style: { color: '#e0861a', stroke: 0 },
  });
  for (const side of [-1, 1]) {
    // The arm hangs from a shoulder node, which the clip turns.
    const shoulder = new Node({
      id: side < 0 ? 'shoulder-left' : 'shoulder-right',
      bone: true,
      position: { x: side * 24, y: -10, z: 0 },
    });
    shoulder.add(
      new PathShape({
        path: [
          { type: 'move', point: { x: 0, y: 0, z: 0 } },
          { type: 'line', point: { x: side * 12, y: 26, z: 0 } },
        ],
        closed: false,
        style: { stroke: 10, color: '#e0861a' },
      }),
    );
    body.add(shoulder);
  }
  root.add(body);
  const rig = new Rig(root, {
    root: 'mascot',
    body: 'body',
    head: 'head',
    eyes: 'eyes',
    lids: 'lids',
    'ear.L': 'ear-left',
    'ear.R': 'ear-right',
    'arm.L': 'shoulder-left',
    'arm.R': 'shoulder-right',
  });
  return { root, camera, rig };
}

/** The right arm goes up and waves. */
const waveClip: Clip = {
  duration: 1.2,
  loop: 'pingpong',
  tracks: [
    {
      target: { slot: 'arm.R' },
      property: 'rotation',
      keys: [
        { time: 0, value: rotation(0, 0, -1.9), easing: 'sineInOut' },
        { time: 1.2, value: rotation(0, 0, -2.6) },
      ],
    },
  ],
};

/** Breathing (body scale and a head bob) and a slight sway of the head, added on top of the clip. */
const idle: BehaviorSet = {
  behaviors: [
    {
      kind: 'oscillate',
      target: { slot: 'body' },
      property: 'scale',
      from: { x: 1, y: 1, z: 1 },
      to: { x: 1.05, y: 1.05, z: 1.05 },
      period: 3.2,
    },
    {
      kind: 'oscillate',
      target: { slot: 'head' },
      property: 'position',
      from: { x: 0, y: 0, z: 0 },
      to: { x: 0, y: -2.5, z: 0 },
      period: 3.2,
    },
    {
      kind: 'noise',
      target: { slot: 'head' },
      property: 'rotation',
      from: rotation(0.06, -0.25, -0.05),
      to: rotation(-0.06, 0.25, 0.05),
      frequency: 0.6,
      seed: 7,
    },
  ],
};

/** Now and then a quick tilt of the head, which sets the ears swinging. */
const tilt: BehaviorSet = {
  behaviors: [
    {
      kind: 'blink',
      target: { slot: 'head' },
      property: 'rotation',
      from: rotation(0, 0, 0),
      to: rotation(0, 0, 0.22),
      duration: 1,
      minInterval: 2.5,
      maxInterval: 5,
      seed: 11,
    },
  ],
};

/** Blinking: the eyes hide and the closed lids show for a moment. */
const blink: BehaviorSet = {
  behaviors: [
    {
      kind: 'blink',
      target: { slot: 'eyes' },
      property: 'visible',
      from: true,
      to: false,
      duration: 0.18,
      minInterval: 1.5,
      maxInterval: 4.5,
      seed: 3,
    },
    {
      kind: 'blink',
      target: { slot: 'lids' },
      property: 'visible',
      from: false,
      to: true,
      duration: 0.18,
      minInterval: 1.5,
      maxInterval: 4.5,
      seed: 3,
    },
  ],
};

/**
 * Sets up the mascot's layers, constraints and springs on `animator`, whose scene holds a
 * mascot from `build` and whose rig is that mascot's rig. Returns the `gaze`: an aim of the
 * head at `gaze.point`, off (weight 0, no point) until the page sets its point and raises its
 * weight.
 */
function animate(animator: Animator): { gaze: AimConstraint } {
  animator.addLayer({ name: 'body' }).play(waveClip);
  animator.addLayer({ name: 'idle', mode: 'additive' }).play(idle);
  animator.addLayer({ name: 'tilt', mode: 'additive' }).play(tilt);
  animator.addLayer({ name: 'face', mask: { slot: 'head' } }).play(blink);
  // The head turns its face (z) towards the gaze point, at most about 30°.
  const gaze = animator.addConstraint({
    kind: 'aim',
    target: { slot: 'head' },
    maxAngle: 0.55,
    weight: 0,
  });
  for (const side of [-1, 1]) {
    animator.addSpring({
      target: { slot: side < 0 ? 'ear.L' : 'ear.R' },
      tip: earTip(side),
      frequency: 1.8,
      damping: 0.15,
      maxAngle: 0.6,
    });
  }
  return { gaze };
}

/** The animated mascot: builds the scene and sets up its layers, gaze constraint and springs. */
export const animatedMascot = {
  id: 'engine-animated-mascot',
  title: 'Mascot: waves, breathes, blinks, swings its ears, follows the pointer',
  width: 240,
  height: 280,
  background: '#e8f1f2',
  build,
  animate,
} as const;
