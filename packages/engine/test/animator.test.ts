import { describe, expect, it } from 'vitest';
import { Animator, type Clip, Node, PathShape, Scene, type Track } from '../src/index.ts';

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
    expect(layer.clip).toBeNull();
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
    expect(q(played.body)).not.toEqual([0, 0, 0, 1]);
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
});
