import { color, euler, quat, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  bindClip,
  type Clip,
  Cylinder,
  clipTime,
  findProperty,
  Node,
  PathShape,
  Rect,
  Scene,
  segmentAt,
  type Track,
} from '../src/index.ts';

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

function clip(tracks: Track[], duration = 2, loop: Clip['loop'] = 'once'): Clip {
  return { duration, loop, tracks };
}

describe('clipTime', () => {
  it('once holds the ends, loop repeats, pingpong goes back and forth', () => {
    expect([-1, 0, 1.5, 2, 5].map((t) => clipTime(2, 'once', t))).toEqual([0, 0, 1.5, 2, 2]);
    expect([-0.5, 0, 1.5, 2, 5].map((t) => clipTime(2, 'loop', t))).toEqual([1.5, 0, 1.5, 0, 1]);
    expect([-0.5, 0, 1.5, 2, 3, 4, 5].map((t) => clipTime(2, 'pingpong', t))).toEqual([
      0.5, 0, 1.5, 2, 1, 0, 1,
    ]);
    expect(clipTime(0, 'loop', 3)).toBe(0);
  });
});

describe('segmentAt', () => {
  it('finds the segment that contains the time', () => {
    const times = new Float64Array([0, 1, 1, 3]);
    expect([-1, 0, 0.5, 1, 2, 3, 4].map((t) => segmentAt(times, t))).toEqual([
      -1, 0, 0, 2, 2, 3, 3,
    ]);
    expect(segmentAt(new Float64Array([]), 0)).toBe(-1);
  });
});

describe('bindClip', () => {
  it('numbers: linear by default, easing per key, ends held', () => {
    const node = new PathShape({ id: 'n' });
    const binding = bindClip(
      clip([
        {
          target: 'n',
          property: 'opacity',
          keys: [
            { time: 0.5, value: 0, easing: 'quadIn' },
            { time: 1.5, value: 1 },
          ],
        },
        {
          target: 'n',
          property: 'zBias',
          keys: [
            { time: 0, value: 0 },
            { time: 2, value: 10 },
          ],
        },
      ]),
      sceneWith(node),
    );
    binding.apply(0);
    expect([node.opacity, node.zBias]).toEqual([0, 0]);
    binding.apply(1);
    expect(node.opacity).toBeCloseTo(0.25, 12);
    expect(node.zBias).toBeCloseTo(5, 12);
    binding.apply(3);
    expect([node.opacity, node.zBias]).toEqual([1, 10]);
  });

  it('vectors interpolate per component, quaternions with slerp', () => {
    const node = new Node({ id: 'n' });
    const turn = quat.fromEuler(quat.create(), euler.create(0, Math.PI / 2, 0));
    // A non-unit key is normalized when bound.
    const doubled = { x: turn.x * 2, y: turn.y * 2, z: turn.z * 2, w: turn.w * 2 };
    const binding = bindClip(
      clip([
        {
          target: 'n',
          property: 'position',
          keys: [
            { time: 0, value: { x: 0, y: 0, z: 0 } },
            { time: 2, value: { x: 2, y: -4, z: 6 } },
          ],
        },
        {
          target: 'n',
          property: 'rotation',
          keys: [
            { time: 0, value: { x: 0, y: 0, z: 0, w: 1 } },
            { time: 2, value: doubled },
          ],
        },
      ]),
      sceneWith(node),
    );
    binding.apply(1);
    expect(vec3.clone(node.position)).toEqual({ x: 1, y: -2, z: 3 });
    const half = quat.fromEuler(quat.create(), euler.create(0, Math.PI / 4, 0));
    expect(quat.equalsRotation(node.rotation, half, 1e-12)).toBe(true);
    binding.apply(2);
    expect(quat.equalsRotation(node.rotation, turn, 1e-12)).toBe(true);
  });

  it('colors mix in OKLab; a null key of a nullable color is held as a step', () => {
    const rect = new Rect({ id: 'r' });
    const cylinder = new Cylinder({ id: 'c' });
    const binding = bindClip(
      clip([
        {
          target: 'r',
          property: 'style.color',
          keys: [
            { time: 0, value: '#000000' },
            { time: 2, value: '#ffffff' },
          ],
        },
        {
          target: 'c',
          property: 'frontFaceColor',
          keys: [
            { time: 0, value: null },
            { time: 1, value: '#ff0000' },
          ],
        },
      ]),
      sceneWith(rect, cylinder),
    );
    binding.apply(1);
    const black = color.parseOrThrow('#000000');
    const white = color.parseOrThrow('#ffffff');
    expect(rect.style.color).toBe(color.toHex(color.mix(color.create(), black, white, 0.5)));
    binding.apply(0.5);
    expect(cylinder.frontFaceColor).toBeNull();
    binding.apply(1);
    expect(cylinder.frontFaceColor).toBe('#ff0000');
  });

  it('booleans and enums step: the value of the key at or before the time', () => {
    const rect = new Rect({ id: 'r' });
    const binding = bindClip(
      clip([
        {
          target: 'r',
          property: 'visible',
          keys: [
            { time: 0, value: true },
            { time: 1, value: false },
          ],
        },
        {
          target: 'r',
          property: 'style.fill',
          keys: [
            { time: 0.5, value: true },
            { time: 1.5, value: false },
          ],
        },
      ]),
      sceneWith(rect),
    );
    binding.apply(0.99);
    expect([rect.visible, rect.style.fill]).toEqual([true, true]);
    binding.apply(1);
    expect(rect.visible).toBe(false);
    binding.apply(0.2);
    // Before the first key its value is held.
    expect(rect.style.fill).toBe(true);
  });

  it('seeking gives the same values as playing up to that time', () => {
    const build = () => {
      const node = new Rect({ id: 'n' });
      return { node, scene: sceneWith(node) };
    };
    const animation = clip(
      [
        {
          target: 'n',
          property: 'position',
          keys: [
            { time: 0, value: { x: 0, y: 0, z: 0 }, easing: 'sineInOut' },
            { time: 0.7, value: { x: 5, y: 1, z: 0 }, easing: 'backOut' },
            { time: 1.3, value: { x: -2, y: 3, z: 4 } },
          ],
        },
        {
          target: 'n',
          property: 'width',
          keys: [
            { time: 0, value: 1 },
            { time: 1.3, value: 9 },
          ],
        },
        {
          target: 'n',
          property: 'style.color',
          keys: [
            { time: 0, value: '#f6a623' },
            { time: 1.3, value: '#2266ff' },
          ],
        },
      ],
      1.3,
      'pingpong',
    );
    const played = build();
    const playing = bindClip(animation, played.scene);
    let time = 0;
    for (let frame = 0; frame < 250; frame++) {
      time += 1 / 60;
      playing.apply(time);
    }
    const sought = build();
    bindClip(animation, sought.scene).apply(time);
    for (const name of ['position', 'width', 'style.color']) {
      const property = findProperty(Rect, name);
      if (!property) throw new Error(name);
      const value = (node: Rect) => {
        if (property.type === 'vec3') return { ...property.get(node, vec3.create()) };
        if (property.type === 'quat') return { ...property.get(node, quat.create()) };
        return property.get(node);
      };
      expect(value(sought.node), name).toEqual(value(played.node));
    }
  });

  it('rejects clips that do not fit the scene, naming the track', () => {
    const scene = sceneWith(new Rect({ id: 'r' }));
    const bad = (track: Partial<Track> & { keys?: Track['keys'] }, extra?: Partial<Clip>) => () =>
      bindClip(
        {
          duration: 2,
          loop: 'once',
          ...extra,
          tracks: [{ target: 'r', property: 'opacity', keys: [{ time: 0, value: 1 }], ...track }],
        },
        scene,
      );
    expect(bad({ target: 'missing' })).toThrow(/r?missing\.opacity: no node/);
    expect(bad({ property: 'wobble' })).toThrow(/has no property "wobble"/);
    expect(bad({ property: 'sortMode', keys: [{ time: 0, value: 'auto' }] })).toThrow(
      /not animatable/,
    );
    expect(bad({ keys: [] })).toThrow(/at least one key/);
    expect(
      bad({
        keys: [
          { time: 1, value: 0 },
          { time: 0.5, value: 1 },
        ],
      }),
    ).toThrow(/earlier than key 0/);
    expect(bad({ keys: [{ time: 3, value: 1 }] })).toThrow(/outside the clip/);
    expect(bad({ keys: [{ time: 0, value: 'half' }] })).toThrow(/finite number/);
    expect(bad({ property: 'position', keys: [{ time: 0, value: { x: 1 } }] })).toThrow(/vector/);
    expect(
      bad({ property: 'rotation', keys: [{ time: 0, value: { x: 0, y: 0, z: 0, w: 0 } }] }),
    ).toThrow(/non-zero quaternion/);
    expect(bad({ property: 'style.color', keys: [{ time: 0, value: 'nope' }] })).toThrow(
      /CSS color/,
    );
    expect(bad({ property: 'visible', keys: [{ time: 0, value: 1 }] })).toThrow(/boolean/);
    expect(bad({}, { duration: -1 })).toThrow(RangeError);
    expect(bad({}, { loop: 'bounce' as never })).toThrow(/loop mode/);
    // Values are still validated by the node when applied.
    expect(() => bad({ keys: [{ time: 0, value: Number.NaN }] })()).toThrow(/finite number/);
  });

  it('a clip changes the scene, so the WebGL frame skip redraws', () => {
    const rect = new Rect({ id: 'r' });
    const scene = sceneWith(rect);
    const binding = bindClip(
      clip([
        {
          target: 'r',
          property: 'width',
          keys: [
            { time: 0, value: 1 },
            { time: 2, value: 3 },
          ],
        },
      ]),
      scene,
    );
    binding.apply(0);
    const version = scene.changeVersion;
    binding.apply(0);
    expect(scene.changeVersion).toBe(version);
    binding.apply(1);
    expect(scene.changeVersion).toBeGreaterThan(version);
  });
});
