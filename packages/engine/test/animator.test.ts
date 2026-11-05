import { color, quat } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  Animator,
  type Clip,
  Cylinder,
  Node,
  PathShape,
  Rect,
  Scene,
  type Track,
} from '../src/index.ts';

function clip(tracks: Track[], duration = 1, loop: Clip['loop'] = 'once'): Clip {
  return { duration, loop, tracks };
}

/** A constant clip: `property` of `target` held at `value`. */
function hold(target: string, property: string, value: unknown): Clip {
  return clip([{ target, property, keys: [{ time: 0, value }] }]);
}

/** `property` of `target` going linearly from `from` to `to` over one second. */
function ramp(target: string, property: string, from: unknown, to: unknown): Clip {
  return clip([
    {
      target,
      property,
      keys: [
        { time: 0, value: from },
        { time: 1, value: to },
      ],
    },
  ]);
}

const QUARTER_Y = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };

function setup() {
  const scene = new Scene();
  const body = new Node({ id: 'body', position: { x: 1, y: 2, z: 3 } });
  const arm = new PathShape({ id: 'arm' });
  const head = new PathShape({ id: 'head' });
  body.add(arm);
  scene.root.add(body);
  scene.root.add(head);
  return { scene, body, arm, head, animator: new Animator(scene) };
}

describe('Animator', () => {
  it('an override layer moves the pose from rest towards its clip by the weight', () => {
    const { arm, animator } = setup();
    arm.opacity = 0.2;
    const layer = animator.addLayer({ weight: 0.5 });
    layer.play(hold('arm', 'opacity', 1));
    animator.update(0);
    expect(arm.opacity).toBeCloseTo(0.6);
    layer.weight = 1;
    animator.evaluate();
    expect(arm.opacity).toBeCloseTo(1);
    layer.weight = 0;
    animator.evaluate();
    expect(arm.opacity).toBeCloseTo(0.2);
  });

  it('upper override layers win over lower ones by their weight', () => {
    const { arm, animator } = setup();
    animator.addLayer({ name: 'base' }).play(hold('arm', 'opacity', 0));
    const top = animator.addLayer({ name: 'top', weight: 0.25 });
    top.play(hold('arm', 'opacity', 1));
    animator.evaluate();
    expect(arm.opacity).toBeCloseTo(0.25);
    expect(animator.layer('top')).toBe(top);
    expect(animator.layer('missing')).toBeNull();
    expect(animator.layers.map((layer) => layer.name)).toEqual(['base', 'top']);
  });

  it('an additive layer adds how far its clip is from its first frame', () => {
    const { body, animator } = setup();
    animator.addLayer().play(ramp('body', 'position', { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }));
    const bob = animator.addLayer({ mode: 'additive', weight: 0.5 });
    bob.play(ramp('body', 'position', { x: 5, y: 5, z: 5 }, { x: 5, y: 7, z: 5 }));
    animator.update(0.5);
    // Base at x = 5; the additive clip is 1 above its first frame, at half weight.
    expect(body.position.x).toBeCloseTo(5);
    expect(body.position.y).toBeCloseTo(0.5);
    expect(body.position.z).toBeCloseTo(0);
  });

  it('additive rotations compose with the pose', () => {
    const { body, animator } = setup();
    animator.addLayer().play(hold('body', 'rotation', QUARTER_Y));
    animator
      .addLayer({ mode: 'additive' })
      .play(ramp('body', 'rotation', { x: 0, y: 0, z: 0, w: 1 }, QUARTER_Y));
    animator.update(1);
    // Two quarter turns about y: a half turn.
    expect(Math.abs(body.rotation.y)).toBeCloseTo(1);
    expect(body.rotation.w).toBeCloseTo(0);
  });

  it('a mask limits a layer to the subtree of a node', () => {
    const { arm, head, animator } = setup();
    const layer = animator.addLayer({ mask: 'body' });
    layer.play(
      clip([
        { target: 'arm', property: 'opacity', keys: [{ time: 0, value: 0.5 }] },
        { target: 'head', property: 'opacity', keys: [{ time: 0, value: 0.5 }] },
      ]),
    );
    animator.evaluate();
    expect(arm.opacity).toBeCloseTo(0.5);
    expect(head.opacity).toBe(1);
    layer.mask = null;
    animator.evaluate();
    expect(head.opacity).toBeCloseTo(0.5);
    expect(() => animator.addLayer({ mask: 'nobody' })).toThrow(/nobody/);
  });

  it('a crossfade changes the pose continuously from the old clip to the new one', () => {
    const { arm, animator } = setup();
    const layer = animator.addLayer();
    layer.play(hold('arm', 'opacity', 0));
    animator.update(0.1);
    expect(arm.opacity).toBeCloseTo(0);
    layer.play(hold('arm', 'opacity', 1), { fade: 0.4 });
    expect(layer.fading).toBe(true);
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      animator.update(0.1);
      values.push(arm.opacity);
    }
    expect(values[0]).toBeCloseTo(0.25);
    expect(values[1]).toBeCloseTo(0.5);
    expect(values[3]).toBeCloseTo(1);
    expect(layer.fading).toBe(false);
  });

  it('channels only in the old or only in the new clip fade from and to rest', () => {
    const { arm, head, animator } = setup();
    const layer = animator.addLayer();
    layer.play(hold('arm', 'opacity', 0));
    layer.play(hold('head', 'opacity', 0), { fade: 1 });
    animator.update(0.25);
    expect(arm.opacity).toBeCloseTo(0.25);
    expect(head.opacity).toBeCloseTo(0.75);
    animator.update(1);
    expect(arm.opacity).toBe(1);
    expect(head.opacity).toBeCloseTo(0);
  });

  it('stopping with a fade returns to rest, and untouched channels stay at rest', () => {
    const { arm, animator } = setup();
    arm.opacity = 0.8;
    const layer = animator.addLayer();
    layer.play(hold('arm', 'opacity', 0));
    animator.update(0);
    expect(arm.opacity).toBeCloseTo(0);
    layer.stop({ fade: 0.5 });
    animator.update(0.25);
    expect(arm.opacity).toBeCloseTo(0.4);
    animator.update(0.25);
    expect(arm.opacity).toBeCloseTo(0.8);
    expect(layer.motion).toBeNull();
  });

  it('seeking gives the same frame as playing up to the time', () => {
    const make = () => {
      const world = setup();
      const base = world.animator.addLayer();
      base.play(
        clip(
          [
            {
              target: 'arm',
              property: 'opacity',
              keys: [
                { time: 0, value: 0 },
                { time: 2, value: 1, easing: 'sineInOut' },
              ],
            },
          ],
          2,
          'pingpong',
        ),
      );
      const add = world.animator.addLayer({ mode: 'additive', weight: 0.7 });
      add.play(ramp('body', 'rotation', { x: 0, y: 0, z: 0, w: 1 }, QUARTER_Y));
      return { ...world, base, add };
    };
    const played = make();
    for (let i = 0; i < 77; i++) played.animator.update(1 / 60);
    const sought = make();
    sought.base.time = played.base.time;
    sought.add.time = played.add.time;
    sought.animator.evaluate();
    expect(sought.arm.opacity).toBe(played.arm.opacity);
    const q = ({ rotation: r }: Node) => [r.x, r.y, r.z, r.w];
    expect(q(sought.body)).toEqual(q(played.body));
    // 0.7 of a quarter turn about y: the additive clip is at its end.
    expect(played.body.rotation.y).toBeCloseTo(Math.sin((0.7 * Math.PI) / 4));
  });

  it('clips played later add channels without disturbing the others', () => {
    const { arm, body, animator } = setup();
    const a = animator.addLayer();
    a.play(ramp('arm', 'opacity', 0, 1));
    animator.update(0.5);
    const b = animator.addLayer({ mode: 'additive' });
    b.play(ramp('body', 'position', { x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }));
    animator.update(0.25);
    expect(arm.opacity).toBeCloseTo(0.75);
    expect(body.position.y).toBeCloseTo(2.5);
    expect(body.position.x).toBe(1);
  });

  it('rejects invalid weights, blend modes and fades', () => {
    const { animator } = setup();
    expect(() => animator.addLayer({ weight: 1.5 })).toThrow(RangeError);
    expect(() => animator.addLayer({ weight: Number.NaN })).toThrow(RangeError);
    expect(() => animator.addLayer({ mode: 'multiply' as 'override' })).toThrow(RangeError);
    const layer = animator.addLayer();
    expect(() => {
      layer.weight = -0.1;
    }).toThrow(RangeError);
    expect(() => layer.play(hold('arm', 'opacity', 0), { fade: -1 })).toThrow(RangeError);
    expect(() => layer.play(hold('nobody', 'opacity', 0))).toThrow(/nobody/);
  });

  it('a seeked additive rotation turns by the weighted delta', () => {
    const { body, animator } = setup();
    const layer = animator.addLayer({ mode: 'additive', weight: 0.5 });
    layer.play(ramp('body', 'rotation', { x: 0, y: 0, z: 0, w: 1 }, QUARTER_Y));
    layer.time = 1;
    animator.evaluate();
    // Half of a quarter turn about y.
    expect(body.rotation.y).toBeCloseTo(Math.sin(Math.PI / 8));
    expect(body.rotation.w).toBeCloseTo(Math.cos(Math.PI / 8));
  });

  it('an additive rotation applies its delta from the first frame on top of the pose', () => {
    const { body, animator } = setup();
    const axis = (x: number, y: number, z: number) =>
      quat.setAxisAngle(quat.create(), { x, y, z }, Math.PI / 2);
    const qx = axis(1, 0, 0);
    const qy = axis(0, 1, 0);
    const qz = axis(0, 0, 1);
    animator.addLayer().play(hold('body', 'rotation', qx));
    animator
      .addLayer({ mode: 'additive' })
      .play(ramp('body', 'rotation', qy, quat.multiply(quat.create(), qz, qy)));
    animator.update(1);
    const expected = quat.multiply(quat.create(), qz, qx);
    expect(quat.equalsRotation(body.rotation, expected, 1e-9)).toBe(true);
  });

  it('a crossfade on a weighted layer stays scaled by the weight', () => {
    const { arm, head, animator } = setup();
    arm.opacity = 0.2;
    const layer = animator.addLayer({ weight: 0.5 });
    layer.play(
      clip([
        { target: 'arm', property: 'opacity', keys: [{ time: 0, value: 0 }] },
        { target: 'head', property: 'opacity', keys: [{ time: 0, value: 0 }] },
      ]),
    );
    animator.update(0);
    layer.play(hold('arm', 'opacity', 1), { fade: 1 });
    animator.update(0.5);
    // Crossfade target 0.5, half of the way from rest 0.2.
    expect(arm.opacity).toBeCloseTo(0.35);
    // Only in the old clip: half faded out, at half weight.
    expect(head.opacity).toBeCloseTo(0.75);
  });

  it('the clip fading out keeps playing', () => {
    const { arm, animator } = setup();
    const layer = animator.addLayer();
    layer.play(ramp('arm', 'opacity', 0, 1));
    animator.update(0.5);
    layer.play(hold('arm', 'opacity', 0), { fade: 1 });
    animator.update(0.5);
    // The old clip is at its end (1) by now.
    expect(arm.opacity).toBeCloseTo(0.5);
  });

  it('a fade started during another one continues from the blended pose', () => {
    const { arm, animator } = setup();
    const layer = animator.addLayer();
    layer.play(hold('arm', 'opacity', 0));
    layer.play(hold('arm', 'opacity', 1), { fade: 1 });
    animator.update(0.5);
    expect(arm.opacity).toBeCloseTo(0.5);
    layer.play(hold('arm', 'opacity', 0.2), { fade: 1 });
    animator.update(0);
    expect(arm.opacity).toBeCloseTo(0.5);
    animator.update(0.5);
    // The second clip has faded in fully, the third one half way.
    expect(arm.opacity).toBeCloseTo(0.6);
    animator.update(0.5);
    expect(arm.opacity).toBeCloseTo(0.2);
    expect(layer.fading).toBe(false);
  });

  it('a channel missing from a clip in the middle of fades mixes in the right shares', () => {
    const { arm, animator } = setup();
    arm.opacity = 0;
    const layer = animator.addLayer();
    layer.play(hold('arm', 'opacity', 1));
    layer.play(hold('head', 'opacity', 0), { fade: 1 });
    layer.play(hold('arm', 'opacity', 0.2), { fade: 1 });
    animator.update(0.5);
    // The head clip fades the arm half way back to rest (0.5), then the last clip mixes
    // half way towards 0.2.
    expect(arm.opacity).toBeCloseTo(0.35);
  });

  it('playing during a fading stop continues from the pose', () => {
    const { arm, animator } = setup();
    arm.opacity = 0;
    const layer = animator.addLayer();
    layer.play(hold('arm', 'opacity', 1));
    animator.update(0);
    layer.stop({ fade: 1 });
    animator.update(0.5);
    expect(arm.opacity).toBeCloseTo(0.5);
    layer.play(hold('arm', 'opacity', 0.2), { fade: 1 });
    animator.update(0);
    expect(arm.opacity).toBeCloseTo(0.5);
    animator.update(0.5);
    // The stop is complete (rest 0), the new clip half faded in.
    expect(arm.opacity).toBeCloseTo(0.1);
    animator.update(0.5);
    expect(arm.opacity).toBeCloseTo(0.2);
  });

  it('a fade on an empty layer fades in from the pose below', () => {
    const { arm, animator } = setup();
    arm.opacity = 0.2;
    const layer = animator.addLayer();
    layer.play(hold('arm', 'opacity', 1), { fade: 1 });
    expect(layer.fading).toBe(true);
    animator.update(0.5);
    expect(arm.opacity).toBeCloseTo(0.6);
  });

  it('play starts from the given time', () => {
    const { arm, animator } = setup();
    const layer = animator.addLayer();
    layer.play(ramp('arm', 'opacity', 0, 1), { time: 0.25 });
    expect(layer.time).toBe(0.25);
    animator.evaluate();
    expect(arm.opacity).toBeCloseTo(0.25);
  });

  it('an additive layer crossfades its offsets and fades them out on stop', () => {
    const { body, animator } = setup();
    const layer = animator.addLayer({ mode: 'additive' });
    const up = (y: number) => ramp('body', 'position', { x: 0, y: 0, z: 0 }, { x: 0, y, z: 0 });
    // Started at the end, so the offsets are constant: 2 and 4 above rest (y = 2).
    layer.play(up(2), { time: 1 });
    layer.play(up(4), { fade: 1, time: 1 });
    animator.update(0.25);
    expect(body.position.y).toBeCloseTo(2 + 0.75 * 2 + 0.25 * 4);
    animator.update(1);
    expect(body.position.y).toBeCloseTo(6);
    layer.stop({ fade: 1 });
    animator.update(0.5);
    expect(body.position.y).toBeCloseTo(4);
  });

  it('booleans switch half way through a crossfade', () => {
    const { arm, animator } = setup();
    const layer = animator.addLayer();
    layer.play(hold('arm', 'visible', false));
    animator.update(0);
    layer.play(hold('arm', 'visible', true), { fade: 1 });
    animator.update(0.4);
    expect(arm.visible).toBe(false);
    animator.update(0.1);
    expect(arm.visible).toBe(true);
  });

  it('additive colors shift in OKLab; booleans and null colors are not additive', () => {
    const scene = new Scene();
    const rect = new Rect({ id: 'rect', style: { color: '#000000' } });
    const cylinder = new Cylinder({ id: 'cylinder' });
    scene.root.add(rect);
    scene.root.add(cylinder);
    const animator = new Animator(scene);
    const layer = animator.addLayer({ mode: 'additive', weight: 0.5 });
    layer.play(
      clip([
        {
          target: 'rect',
          property: 'style.color',
          keys: [
            { time: 0, value: '#000000' },
            { time: 1, value: '#ffffff' },
          ],
        },
        {
          target: 'rect',
          property: 'visible',
          keys: [
            { time: 0, value: true },
            { time: 1, value: false },
          ],
        },
        {
          target: 'cylinder',
          property: 'frontFaceColor',
          keys: [
            { time: 0, value: '#000000' },
            { time: 1, value: '#ff0000' },
          ],
        },
      ]),
    );
    animator.update(1);
    const black = color.parseOrThrow('#000000');
    const white = color.parseOrThrow('#ffffff');
    expect(rect.style.color).toBe(color.toHex(color.mix(color.create(), black, white, 0.5)));
    expect(rect.visible).toBe(true);
    expect(cylinder.frontFaceColor).toBeNull();
  });

  it('an additive layer keeps its reference when later clips add channels', () => {
    const { body, animator } = setup();
    animator
      .addLayer({ mode: 'additive' })
      .play(ramp('body', 'position', { x: 5, y: 5, z: 5 }, { x: 5, y: 7, z: 5 }));
    animator.update(0.5);
    expect(body.position.y).toBeCloseTo(3);
    animator.addLayer().play(hold('head', 'opacity', 0.5));
    animator.update(0);
    expect(body.position.y).toBeCloseTo(3);
  });

  it('a mask covers channels added later and can be moved to another node', () => {
    const { arm, body, head, animator } = setup();
    const layer = animator.addLayer({ mask: 'body' });
    layer.play(hold('arm', 'opacity', 0.5));
    animator.evaluate();
    layer.play(
      clip([
        { target: 'body', property: 'position', keys: [{ time: 0, value: { x: 0, y: 5, z: 0 } }] },
        { target: 'head', property: 'opacity', keys: [{ time: 0, value: 0.5 }] },
        { target: 'arm', property: 'opacity', keys: [{ time: 0, value: 0.5 }] },
      ]),
    );
    animator.evaluate();
    expect(body.position.y).toBe(5);
    expect(head.opacity).toBe(1);
    layer.mask = 'head';
    animator.evaluate();
    expect(head.opacity).toBeCloseTo(0.5);
    expect(arm.opacity).toBe(1);
    expect(body.position.y).toBe(2);
    expect(() => {
      layer.mask = 'nobody';
    }).toThrow(/nobody/);
    expect(layer.mask).toBe('head');
    animator.evaluate();
  });

  it('a clip that fails to compile leaves the animator working', () => {
    const { arm, head, animator } = setup();
    arm.opacity = 0.3;
    const layer = animator.addLayer();
    expect(() =>
      layer.play(
        clip([
          { target: 'arm', property: 'opacity', keys: [{ time: 0, value: 0 }] },
          { target: 'nobody', property: 'opacity', keys: [{ time: 0, value: 0 }] },
        ]),
      ),
    ).toThrow(/nobody/);
    animator.update(0);
    expect(arm.opacity).toBeCloseTo(0.3);
    layer.play(hold('head', 'opacity', 0.5));
    animator.update(0);
    expect(arm.opacity).toBeCloseTo(0.3);
    expect(head.opacity).toBeCloseTo(0.5);
  });

  it('a clip is compiled again when one of its nodes was replaced', () => {
    const { scene, arm, animator } = setup();
    const fade = hold('arm', 'opacity', 0.5);
    const layer = animator.addLayer();
    layer.play(fade);
    animator.evaluate();
    expect(arm.opacity).toBeCloseTo(0.5);
    arm.destroy();
    const replacement = new PathShape({ id: 'arm' });
    scene.root.add(replacement);
    layer.play(fade);
    animator.evaluate();
    expect(replacement.opacity).toBeCloseTo(0.5);
  });

  it('rejects invalid fades and times, and finds the first layer by name', () => {
    const { animator } = setup();
    const first = animator.addLayer({ name: 'face' });
    animator.addLayer({ name: 'face' });
    expect(animator.layer('face')).toBe(first);
    expect(() => first.stop({ fade: -1 })).toThrow(RangeError);
    expect(() => first.stop({ fade: Number.NaN })).toThrow(RangeError);
    expect(() => first.play(hold('arm', 'opacity', 0), { fade: Infinity })).toThrow(RangeError);
    expect(() => first.play(hold('arm', 'opacity', 0), { time: Number.NaN })).toThrow(RangeError);
    expect(() => animator.addLayer({ weight: Infinity })).toThrow(RangeError);
    first.play(hold('arm', 'opacity', 0));
    expect(() => {
      first.time = Number.NaN;
    }).toThrow(RangeError);
    expect(() => animator.update(Number.NaN)).toThrow(RangeError);
  });
});
