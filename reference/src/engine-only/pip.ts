import {
  type AimConstraint,
  type Animator,
  type BehaviorSet,
  Camera,
  type Clip,
  Ellipse,
  Node,
  PathShape,
  Rig,
  Sphere,
  type StateMachine,
  type Track,
} from '@mascotte/engine';
import {
  type AnimationDocument,
  animateDocument,
  FORMAT,
  type MachineDocument,
  type MascotDocument,
  VERSION,
  writeNode,
  writeProps,
} from '@mascotte/format';
import { euler, quat, type Vec3 } from '@mascotte/math';
import type { AnimatedScene } from './scenes.ts';

/*
 * Pip, the showcase mascot: a round yellow chick, all body and no neck. It breathes, blinks,
 * now and then chirps (its beak opens) and tilts its head, its crest feathers swing on springs,
 * and its head can turn towards a point (the pointer, in the playground) through an `aim`
 * constraint. Its emotions are the states of a machine: calm, happy while `hover` holds (wings
 * flap, eyes turn to arcs, beak open) and surprised for a moment after a `poke` (crest up, wide
 * eyes). As for `animatedMascot`, apart from the crest on its springs, with the machine in its
 * initial state and the same gaze, setting the layer times gives the same frame as playing up
 * to them.
 *
 * Its rig binds the bird slots: `root`, `body`, `head`, `eyes`, `eye.L`, `eye.R`,
 * `eyes.happy`, `lids`, `beak.upper`, `beak.lower`, `wing.L`, `wing.R`, `crest.L`, `crest.M`
 * and `crest.R`; every motion addresses slots.
 */

function rotation(x: number, y: number, z: number) {
  const q = quat.fromEuler(quat.create(), euler.create(x, y, z));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** A point on the body sphere in direction (x, y) on the front side, at `distance` from its center. */
function onBody(x: number, y: number, distance = radius) {
  const z = Math.sqrt(Math.max(0, radius * radius - x * x - y * y));
  const length = Math.hypot(x, y, z) || 1;
  return { x: (x / length) * distance, y: (y / length) * distance, z: (z / length) * distance };
}

const radius = 52;
const yellow = '#ffd54a';
const belly = '#fff0b3';
const wingColor = '#f7c232';
const orange = '#ff9a1f';
const dark = '#3a2410';
// The wings face out to the sides and half forward.
const wingYaw = 0.9;

/** The crest feathers: where each grows on the head (left, middle, right) and its tip from there. */
const feathers = [
  { side: 'L', base: { x: -6, y: -radius + 2, z: 4 }, tip: { x: -10, y: -18, z: 2 } },
  { side: 'M', base: { x: 0, y: -radius, z: 2 }, tip: { x: 1, y: -24, z: 0 } },
  { side: 'R', base: { x: 6, y: -radius + 2, z: 4 }, tip: { x: 11, y: -17, z: 2 } },
] as const;

/** Where a wing (side −1 left, 1 right) hangs from the body: its shoulder at the side. */
function wingBase(side: number) {
  return { x: side * (radius - 8), y: -radius + 10, z: -6 };
}

function line(from: Vec3, to: Vec3) {
  return [
    { type: 'move' as const, point: from },
    { type: 'line' as const, point: to },
  ];
}

/**
 * Builds Pip: the root `pip` at its feet; `body`, which holds the body sphere with its belly, the
 * wings `wing-left` and `wing-right` and the `head` at the sphere's center; the head holds the
 * face (eyes, cheeks, beak) and the crest. The body's origin is at its bottom, so breathing
 * swells it upwards.
 */
function build(): { root: Node; camera: Camera; rig: Rig } {
  const root = new Node({
    id: 'pip',
    bone: true,
    position: { x: 0, y: 62, z: 0 },
    rotation: euler.create(-0.12, 0.35, 0),
  });
  const camera = new Camera({ zoom: 1.4 });
  const body = new Node({ id: 'body', bone: true });
  const sphere = new Sphere({
    diameter: radius * 2,
    position: { x: 0, y: -radius, z: 0 },
    style: { color: yellow, stroke: 0 },
  });
  // The belly: a lighter decal on the body's front, cut to its outline.
  sphere.add(
    new Ellipse({
      sortMode: 'attached',
      width: 58,
      height: 54,
      position: { x: 0, y: 20, z: radius - 6 },
      style: { color: belly, stroke: 4, fill: true },
    }),
  );
  body.add(sphere);
  for (const side of [-1, 1]) {
    // A wing hangs from its shoulder node, which the motions turn.
    const wing = new Node({
      id: side < 0 ? 'wing-left' : 'wing-right',
      bone: true,
      position: wingBase(side),
      rotation: euler.create(0, 0, -side * 0.15),
    });
    wing.add(
      new Ellipse({
        width: 13,
        height: 28,
        position: { x: side * 2, y: 15, z: 0 },
        rotation: euler.create(0, side * wingYaw, 0),
        style: { color: wingColor, stroke: 10, fill: true, backfaceVisible: true },
      }),
    );
    body.add(wing);
  }
  const head = new Node({ id: 'head', bone: true, position: { x: 0, y: -radius, z: 0 } });
  body.add(head);
  for (const feather of feathers) {
    const node = new Node({
      id: `crest-${feather.side.toLowerCase()}`,
      bone: true,
      position: feather.base,
    });
    node.add(
      new PathShape({
        path: line({ x: 0, y: 0, z: 0 }, feather.tip),
        closed: false,
        style: { stroke: 7, color: orange },
      }),
    );
    head.add(node);
  }
  const eyes = new Node({ id: 'eyes' });
  const happy = new Node({ id: 'eyes-happy', visible: false });
  const lids = new Node({ id: 'lids', visible: false });
  for (const side of [-1, 1]) {
    // An eye on its own node, so it scales with its highlight about its center (wide eyes).
    const eye = new Node({
      id: side < 0 ? 'eye-left' : 'eye-right',
      position: onBody(side * 17, -10, radius + 1),
    });
    eye.add(new Sphere({ diameter: 13, style: { color: dark, stroke: 0 } }));
    eye.add(
      new Sphere({
        diameter: 4,
        position: { x: -2, y: -2.5, z: 5 },
        style: { color: '#ffffff', stroke: 0 },
      }),
    );
    eyes.add(eye);
    // A happy eye: an arc, like ^.
    const arc = [];
    for (let i = 0; i <= 6; i++) {
      const x = side * 17 - 6 + 2 * i;
      const y = -9 - (1 - ((x - side * 17) / 6) ** 2) * 5;
      arc.push({
        type: i === 0 ? ('move' as const) : ('line' as const),
        point: onBody(x, y, radius + 2),
      });
    }
    happy.add(new PathShape({ path: arc, closed: false, style: { stroke: 3.5, color: dark } }));
    // A closed eye: a short line.
    lids.add(
      new PathShape({
        path: line(onBody(side * 17 - 6, -9, radius + 2), onBody(side * 17 + 6, -9, radius + 2)),
        closed: false,
        style: { stroke: 3, color: dark },
      }),
    );
    head.add(
      new Sphere({
        diameter: 13,
        position: onBody(side * 30, 6, radius - 2),
        style: { color: '#ffa48a', stroke: 0 },
      }),
    );
  }
  eyes.add(happy);
  head.add(eyes);
  head.add(lids);
  // The beak: two parts hinged where they meet the face; the lower one turns down to open it.
  const hinge = onBody(0, 3, radius - 1);
  const upper = new Node({ id: 'beak-upper', position: hinge });
  upper.add(
    new PathShape({
      path: [
        { type: 'move', point: { x: -8, y: -3, z: 0 } },
        { type: 'line', point: { x: 8, y: -3, z: 0 } },
        { type: 'line', point: { x: 0, y: 3, z: 13 } },
      ],
      style: { stroke: 5, color: orange, fill: true },
    }),
  );
  const lower = new Node({ id: 'beak-lower', position: hinge });
  lower.add(
    new PathShape({
      path: [
        { type: 'move', point: { x: -6, y: 2, z: 0 } },
        { type: 'line', point: { x: 6, y: 2, z: 0 } },
        { type: 'line', point: { x: 0, y: 4, z: 9 } },
      ],
      style: { stroke: 5, color: '#f07f12', fill: true },
    }),
  );
  head.add(upper);
  head.add(lower);
  root.add(body);
  for (const side of [-1, 1]) {
    // A foot: two toes forward from the ankle.
    const foot = new Node({ position: { x: side * 16, y: -2, z: 6 } });
    for (const toe of [-1, 1]) {
      foot.add(
        new PathShape({
          path: line({ x: 0, y: 0, z: 0 }, { x: toe * 5, y: 0, z: 10 }),
          closed: false,
          style: { stroke: 6, color: orange },
        }),
      );
    }
    root.add(foot);
  }
  const rig = new Rig(root, {
    root: 'pip',
    body: 'body',
    head: 'head',
    eyes: 'eyes',
    'eye.L': 'eye-left',
    'eye.R': 'eye-right',
    'eyes.happy': 'eyes-happy',
    lids: 'lids',
    'beak.upper': 'beak-upper',
    'beak.lower': 'beak-lower',
    'wing.L': 'wing-left',
    'wing.R': 'wing-right',
    'crest.L': 'crest-l',
    'crest.M': 'crest-m',
    'crest.R': 'crest-r',
  });
  return { root, camera, rig };
}

type Value = Track['keys'][number]['value'];

/** A track that holds `value`. */
function hold(slot: string, property: Track['property'], value: Value): Track {
  return { target: { slot }, property, keys: [{ time: 0, value }] };
}

/** A wing (side −1 left, 1 right) turned out from the body by `angle` (towards level when large). */
function wing(side: number, angle: number) {
  return rotation(0, 0, -side * angle);
}

/** The beak open by `angle`. */
function beak(angle: number) {
  return rotation(-angle, 0, 0);
}

const one = { x: 1, y: 1, z: 1 };

/**
 * A held pose of the wings (the first two tracks), face and crest: every emotion sets these
 * slots and properties, so a transition fades each of them.
 */
function pose(options: {
  wings: number;
  beak: number;
  happyEyes: boolean;
  eyeScale: number;
  crest: number;
}): Track[] {
  const eye = { x: options.eyeScale, y: options.eyeScale, z: options.eyeScale };
  const crest = { x: 1, y: options.crest, z: 1 };
  return [
    hold('wing.L', 'rotation', wing(-1, options.wings)),
    hold('wing.R', 'rotation', wing(1, options.wings)),
    hold('beak.lower', 'rotation', beak(options.beak)),
    hold('eye.L', 'visible', !options.happyEyes),
    hold('eye.R', 'visible', !options.happyEyes),
    hold('eyes.happy', 'visible', options.happyEyes),
    hold('eye.L', 'scale', eye),
    hold('eye.R', 'scale', eye),
    hold('crest.L', 'scale', crest),
    hold('crest.M', 'scale', crest),
    hold('crest.R', 'scale', crest),
  ];
}

const calmClip: Clip = {
  duration: 0,
  loop: 'once',
  tracks: pose({ wings: 0.15, beak: 0, happyEyes: false, eyeScale: 1, crest: 1 }),
};

/** Happy: wings raised and flapping, eyes as arcs, beak open. */
const happyClip: Clip = {
  duration: 0.24,
  loop: 'pingpong',
  tracks: [
    // The pose without its held wings, which flap instead.
    ...pose({ wings: 1.1, beak: 0.5, happyEyes: true, eyeScale: 1, crest: 1 }).slice(2),
    ...[-1, 1].map((side) => ({
      target: { slot: side < 0 ? 'wing.L' : 'wing.R' },
      property: 'rotation' as const,
      keys: [
        { time: 0, value: wing(side, 0.8), easing: 'sineInOut' as const },
        { time: 0.24, value: wing(side, 1.4) },
      ],
    })),
  ],
};

/**
 * Surprised: crest up, wide eyes, wings out and the beak a little open, held for 0.9 s; then the
 * machine leaves it.
 */
const surprisedClip: Clip = {
  duration: 0.9,
  loop: 'once',
  tracks: pose({ wings: 0.7, beak: 0.3, happyEyes: false, eyeScale: 1.45, crest: 1.45 }),
};

/**
 * The emotions: calm, happy while `hover` holds, and on a `poke` surprised for a moment, then
 * happy or calm again by the hover.
 */
const emotionMachine: MachineDocument = {
  name: 'emotion',
  layer: 'emotion',
  inputs: [
    { name: 'hover', type: 'bool' },
    { name: 'poke', type: 'trigger' },
  ],
  states: [
    { name: 'calm', motion: 'calm' },
    { name: 'happy', motion: 'happy' },
    { name: 'surprised', motion: 'surprised' },
  ],
  transitions: [
    { from: '*', to: 'surprised', conditions: [{ input: 'poke' }], duration: 0.08 },
    { from: 'calm', to: 'happy', conditions: [{ input: 'hover' }], duration: 0.25 },
    { from: 'happy', to: 'calm', conditions: [{ input: 'hover', value: false }], duration: 0.3 },
    {
      from: 'surprised',
      to: 'happy',
      exitTime: 1,
      conditions: [{ input: 'hover' }],
      duration: 0.3,
    },
    {
      from: 'surprised',
      to: 'calm',
      exitTime: 1,
      conditions: [{ input: 'hover', value: false }],
      duration: 0.3,
    },
  ],
};

/** Breathing (the body swells upwards) and a slight sway of the head, added on top. */
const idle: BehaviorSet = {
  behaviors: [
    {
      kind: 'oscillate',
      target: { slot: 'body' },
      property: 'scale',
      from: one,
      to: { x: 1.03, y: 1.05, z: 1.03 },
      period: 2.8,
    },
    {
      kind: 'noise',
      target: { slot: 'head' },
      property: 'rotation',
      from: rotation(0.05, -0.2, -0.08),
      to: rotation(-0.05, 0.2, 0.08),
      frequency: 0.5,
      seed: 5,
    },
  ],
};

/** Now and then a quick, bird-like tilt of the head, which sets the crest swinging. */
const tilt: BehaviorSet = {
  behaviors: [
    {
      kind: 'blink',
      target: { slot: 'head' },
      property: 'rotation',
      from: rotation(0, 0, 0),
      to: rotation(0.08, 0, -0.3),
      duration: 0.9,
      minInterval: 2.5,
      maxInterval: 5,
      seed: 21,
    },
  ],
};

/** Now and then a chirp: the beak opens for a moment. */
const chirp: BehaviorSet = {
  behaviors: [
    {
      kind: 'blink',
      target: { slot: 'beak.lower' },
      property: 'rotation',
      from: rotation(0, 0, 0),
      to: beak(0.45),
      duration: 0.3,
      minInterval: 3,
      maxInterval: 6,
      seed: 13,
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
      duration: 0.16,
      minInterval: 1.8,
      maxInterval: 4.5,
      seed: 9,
    },
    {
      kind: 'blink',
      target: { slot: 'lids' },
      property: 'visible',
      from: false,
      to: true,
      duration: 0.16,
      minInterval: 1.8,
      maxInterval: 4.5,
      seed: 9,
    },
  ],
};

/**
 * Pip's motions, layers, emotion machine, gaze and springs as document data: the gaze is the
 * constraint named `gaze`.
 */
const animation: AnimationDocument = {
  motions: {
    calm: calmClip,
    happy: happyClip,
    surprised: surprisedClip,
    idle,
    tilt,
    chirp,
    blink,
  },
  layers: [
    { name: 'emotion' },
    { name: 'idle', mode: 'additive', play: 'idle' },
    { name: 'tilt', mode: 'additive', play: 'tilt' },
    { name: 'chirp', mode: 'additive', play: 'chirp' },
    { name: 'blink', mask: { slot: 'head' }, play: 'blink' },
  ],
  machines: [emotionMachine],
  constraints: [
    // The head turns its face (z) towards the gaze point, at most about 25°.
    { name: 'gaze', kind: 'aim', target: { slot: 'head' }, maxAngle: 0.45, weight: 0 },
  ],
  springs: feathers.map((feather) => ({
    target: { slot: `crest.${feather.side}` },
    tip: feather.tip,
    frequency: 2.2,
    damping: 0.12,
    maxAngle: 0.7,
  })),
};

/**
 * Sets up Pip's layers, emotion machine, gaze and springs on `animator`, whose scene holds Pip
 * from `build` and whose rig is Pip's rig. Returns the `gaze` (off until the page sets its
 * point and raises its weight) and the `emotion` machine, driven by `hover` (a bool) and
 * `poke` (a trigger) on `animator.inputs`.
 */
function animate(animator: Animator): { gaze: AimConstraint; emotion: StateMachine } {
  const { machines, constraints } = animateDocument(animation, animator);
  return { gaze: constraints.get('gaze') as AimConstraint, emotion: machines[0] as StateMachine };
}

/** Pip as a mascot document: the tree and rig from `build`, the animation data above. */
export function pipDocument(): MascotDocument {
  const { root, camera, rig } = build();
  return {
    format: FORMAT,
    version: VERSION,
    meta: { name: 'Pip', description: 'A round yellow chick: the showcase mascot.' },
    view: { width: pip.width, height: pip.height, background: pip.background },
    camera: { props: writeProps(camera) },
    root: writeNode(root),
    rig: { slots: Object.fromEntries(rig.slots) },
    ...animation,
  };
}

/** Pip: builds the scene and sets up its layers, emotion machine, gaze and springs. */
export const pip = {
  id: 'engine-pip',
  title: 'Pip: a chick that follows the pointer, cheers up on hover and startles on a click',
  width: 240,
  height: 240,
  background: '#e6f0ff',
  build,
  animate,
} satisfies AnimatedScene;
