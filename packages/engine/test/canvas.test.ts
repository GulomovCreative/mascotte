import { euler } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  CanvasRenderer,
  type CanvasTarget,
  Capsule,
  Cylinder,
  DisplayList,
  Node,
  PathShape,
  Rect,
  Scene,
  ScreenOp,
  Sphere,
} from '../src/index.ts';

const camera = new Camera();

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

function items(list: DisplayList) {
  return Array.from({ length: list.count }, (_, i) => list.item(i));
}

describe('DisplayList', () => {
  it('a shape projects to pixels with zoom, a point is a circle from the stroke', () => {
    const rect = new Rect({
      width: 10,
      height: 4,
      position: { x: 5, y: 0, z: 0 },
      style: { stroke: 2 },
    });
    const dot = new PathShape({
      position: { x: -30, y: 1, z: 0 },
      style: { stroke: 6, color: '#f00' },
    });
    const list = new DisplayList().build(sceneWith(rect, dot), new Camera({ zoom: 2 }));
    const [a, b] = items(list);
    if (!a || !b) throw new Error('there must be two elements');
    expect(Array.from(a.path.data.subarray(0, a.path.dataCount))).toEqual([
      0, -4, 20, -4, 20, 4, 0, 4,
    ]);
    expect([a.path.closed, a.lineWidth, a.hasStroke, a.hasFill]).toEqual([true, 4, true, false]);
    expect(b.path.ops[0]).toBe(ScreenOp.arc);
    expect(Array.from(b.path.data.subarray(0, 3))).toEqual([-60, 2, 6]);
    expect([b.hasStroke, b.hasFill, b.color]).toEqual([false, true, '#f00']);
  });

  it('back side: hidden, its own color, or the same color', () => {
    const turned = euler.create(0, Math.PI, 0);
    const hidden = new Rect({ id: 'hidden', rotation: turned, style: { backfaceVisible: false } });
    const colored = new Rect({
      id: 'colored',
      rotation: turned,
      style: { color: '#111', backfaceColor: '#abc' },
    });
    const same = new Rect({ id: 'same', rotation: turned, style: { color: '#222' } });
    const front = new Rect({ id: 'front', style: { color: '#333', backfaceColor: '#abc' } });
    const list = new DisplayList().build(sceneWith(hidden, colored, same, front), camera);
    expect(items(list).map((item) => [item.node?.id, item.color])).toEqual([
      ['colored', '#abc'],
      ['same', '#222'],
      ['front', '#333'],
    ]);
  });

  it('opacity includes ancestors; fully transparent and hidden items are skipped', () => {
    const parent = new Node({ opacity: 0.5 });
    parent.add(new Rect({ id: 'half', opacity: 0.5 }));
    const list = new DisplayList().build(
      sceneWith(
        parent,
        new Rect({ id: 'gone', opacity: 0 }),
        new Rect({ id: 'off', visible: false }),
      ),
      camera,
    );
    expect(items(list).map((item) => [item.node?.id, item.opacity])).toEqual([['half', 0.25]]);
  });

  it('an element without stroke and fill is skipped, so is a point without stroke', () => {
    const list = new DisplayList().build(
      sceneWith(
        new Rect({ style: { stroke: 0, fill: false } }),
        new PathShape({ style: { stroke: 0 } }),
      ),
      camera,
    );
    expect(list.count).toBe(0);
  });

  it('stroke scales with the node', () => {
    const list = new DisplayList().build(
      sceneWith(new Rect({ scale: 3, style: { stroke: 2 } })),
      camera,
    );
    expect(list.item(0).lineWidth).toBeCloseTo(6, 12);
  });

  it('solid parts in perspective use the owner depth', () => {
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    const cylinder = new Cylinder({
      length: 40,
      diameter: 10,
      position: { x: 0, y: 0, z: 20 },
      style: { stroke: 0 },
    });
    const list = new DisplayList().build(sceneWith(cylinder), perspective);
    const scale = perspective.scaleAt(20);
    let checked = 0;
    for (const item of items(list)) {
      if (item.node === cylinder.body) continue;
      checked++;
      // The base is in a plane perpendicular to the view: radius = 5 · cylinder depth scale.
      const data = Array.from(item.path.data.subarray(0, item.path.dataCount));
      const ys = data.filter((_, i) => i % 2 === 1);
      expect(Math.max(...ys)).toBeCloseTo(5 * scale, 9);
    }
    expect(checked).toBe(2);
  });

  it('in perspective shape points are scaled by the depth of its origin', () => {
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    // The rect is rotated: its corners are at different depths, but scale uses the origin depth (20).
    const rect = new Rect({
      width: 20,
      height: 10,
      position: { x: 0, y: 0, z: 20 },
      rotation: euler.create(0, 0.6, 0),
    });
    const item = new DisplayList().build(sceneWith(rect), perspective).item(0);
    const s = perspective.scaleAt(20);
    const half = 10 * Math.cos(0.6);
    const xs = Array.from(item.path.data.subarray(0, item.path.dataCount)).filter(
      (_, i) => i % 2 === 0,
    );
    expect(Math.max(...xs)).toBeCloseTo(half * s, 9);
    expect(Math.min(...xs)).toBeCloseTo(-half * s, 9);
  });

  it('a curve projects all three points', () => {
    const curve = new PathShape({
      path: [
        { type: 'move', point: { x: 0 } },
        {
          type: 'bezier',
          control1: { x: 1, y: 2 },
          control2: { x: 3, y: 4 },
          point: { x: 5, y: 6 },
        },
      ],
    });
    const item = new DisplayList().build(sceneWith(curve), new Camera({ zoom: 2 })).item(0);
    expect(item.path.ops[1]).toBe(ScreenOp.cubic);
    expect(Array.from(item.path.data.subarray(2, 8))).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('the back side is relative to the camera, edge-on counts as front', () => {
    const behind = new Camera({ rotation: euler.create(0, Math.PI, 0) });
    expect(
      new DisplayList().build(sceneWith(new Rect({ style: { backfaceVisible: false } })), behind)
        .count,
    ).toBe(0);
    const flat = new Rect({
      scale: { x: 1, y: 1, z: 0 },
      style: { backfaceVisible: false, color: '#123', backfaceColor: '#abc' },
    });
    const item = new DisplayList().build(sceneWith(flat), camera).item(0);
    expect(item.color).toBe('#123');
  });

  it('a skipped shape in the middle of the list leaves no trace', () => {
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    const a = new Rect({ id: 'a', position: { x: 0, y: 0, z: -10 }, style: { color: '#a00' } });
    const b = new Rect({
      id: 'b',
      position: { x: 0, y: 0, z: 0 },
      style: { color: '#0b0', stroke: 7 },
    });
    const c = new Rect({
      id: 'c',
      position: { x: 0, y: 0, z: 10 },
      style: { color: '#00c', stroke: 3 },
    });
    const scene = sceneWith(a, b, c);
    const list = new DisplayList();
    list.build(scene, perspective);
    b.position.z = 500;
    list.build(scene, perspective);
    expect(list.count).toBe(2);
    const second = list.item(1);
    expect([second.node?.id, second.color, second.lineWidth]).toEqual([
      'c',
      '#00c',
      3 * perspective.scaleAt(10),
    ]);
  });

  it('surface opacity and zero stroke width', () => {
    const parent = new Node({ opacity: 0.5 });
    parent.add(new Sphere({ id: 'sphere' }));
    expect(new DisplayList().build(sceneWith(parent), camera).item(0).opacity).toBe(0.5);
    // A capsule squashed to zero width: no stroke, not the width of the previous element.
    const flat = new Capsule({
      length: 40,
      scale: { x: 0, y: 1, z: 1 },
      rotation: euler.create(0, Math.PI / 2, 0),
    });
    const list = new DisplayList().build(
      sceneWith(
        new PathShape({
          path: [
            { type: 'move', point: {} },
            { type: 'line', point: { x: 9 } },
          ],
          style: { stroke: 40 },
        }),
        flat,
      ),
      camera,
    );
    expect(items(list).some((item) => item.node === flat)).toBe(false);
  });

  it('a shape behind the camera eye is not drawn', () => {
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    const list = new DisplayList().build(
      sceneWith(new Rect({ position: { x: 0, y: 0, z: 150 } })),
      perspective,
    );
    expect(list.count).toBe(0);
  });

  it('elements and buffers are reused between frames', () => {
    const scene = sceneWith(new Rect(), new Sphere(), new Cylinder());
    const list = new DisplayList();
    list.build(scene, camera);
    const first = items(list);
    const buffers = first.map((item) => item.path.data);
    list.build(scene, camera);
    const second = items(list);
    second.forEach((item, i) => {
      expect(item).toBe(first[i]);
      expect(item.path.data).toBe(buffers[i]);
    });
    expect(() => list.item(list.count)).toThrow(RangeError);
  });
});

/** A context that records calls and assignments. */
function recordingContext() {
  const calls: string[] = [];
  const target = {
    beginPath: () => calls.push('beginPath'),
    moveTo: (x: number, y: number) => calls.push(`moveTo ${x} ${y}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo ${x} ${y}`),
    bezierCurveTo: (...args: number[]) => calls.push(`bezierCurveTo ${args.join(' ')}`),
    arc: (...args: (number | boolean)[]) => calls.push(`arc ${args.join(' ')}`),
    closePath: () => calls.push('closePath'),
    stroke: () => calls.push('stroke'),
    fill: () => calls.push('fill'),
    setTransform: (...args: number[]) => calls.push(`setTransform ${args.join(' ')}`),
    clearRect: () => calls.push('clearRect'),
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    clip: () => calls.push('clip'),
    fillRect: () => calls.push('fillRect'),
  };
  for (const key of [
    'strokeStyle',
    'fillStyle',
    'lineWidth',
    'lineCap',
    'lineJoin',
    'globalAlpha',
  ]) {
    Object.defineProperty(target, key, {
      set(value: unknown) {
        calls.push(`${key}=${value}`);
      },
    });
  }
  return { ctx: target as unknown as CanvasTarget, calls };
}

describe('CanvasRenderer', () => {
  it('frame center and devicePixelRatio, background or clear', () => {
    const { ctx, calls } = recordingContext();
    new CanvasRenderer().render(ctx, sceneWith(), camera, {
      width: 100,
      height: 50,
      pixelRatio: 2,
      background: '#fff',
    });
    // The frame is cleared even with a background: otherwise a translucent background would pile up over past frames.
    expect(calls).toEqual([
      'setTransform 1 0 0 1 0 0',
      'clearRect',
      'fillStyle=#fff',
      'fillRect',
      'setTransform 2 0 0 2 100 50',
      'lineJoin=round',
      'globalAlpha=1',
    ]);
    const clear = recordingContext();
    new CanvasRenderer().render(clear.ctx, sceneWith(), camera, { width: 100, height: 50 });
    expect(clear.calls).toContain('clearRect');
    expect(clear.calls).not.toContain('fillRect');
    expect(clear.calls).toContain('setTransform 1 0 0 1 50 25');
  });

  it('invalid frame size is an error', () => {
    const { ctx } = recordingContext();
    const renderer = new CanvasRenderer();
    for (const viewport of [
      { width: -1, height: 10 },
      { width: 10, height: Number.NaN },
      { width: 10, height: 10, pixelRatio: 0 },
      { width: 10, height: 10, pixelRatio: Number.NaN },
    ]) {
      expect(
        () => renderer.render(ctx, sceneWith(), camera, viewport),
        JSON.stringify(viewport),
      ).toThrow(RangeError);
    }
  });

  it('context state is switched only on change', () => {
    const { ctx, calls } = recordingContext();
    const shapes = [0, 1, 2].map(
      (i) =>
        new Rect({
          position: { x: i * 20, y: 0, z: i },
          style: { stroke: 2, fill: true, color: '#123' },
        }),
    );
    new CanvasRenderer().render(ctx, sceneWith(...shapes), camera, { width: 100, height: 100 });
    const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
    const exactly = (name: string) => calls.filter((c) => c === name).length;
    expect(count('strokeStyle=')).toBe(1);
    expect(count('fillStyle=')).toBe(1);
    expect(count('lineWidth=')).toBe(1);
    expect(count('lineCap=')).toBe(1);
    expect(exactly('stroke')).toBe(3);
    expect(exactly('fill')).toBe(3);
    expect(exactly('closePath')).toBe(3);
    // Within an element: stroke first, then fill, as in Zdog.
    expect(calls.indexOf('stroke')).toBeLessThan(calls.indexOf('fill'));
  });

  it('globalAlpha switches when opacity changes and is reset at the end', () => {
    const { ctx, calls } = recordingContext();
    const shapes = [0.5, 0.5, 1].map(
      (opacity, i) => new Rect({ opacity, position: { x: 0, y: 0, z: i } }),
    );
    new CanvasRenderer().render(ctx, sceneWith(...shapes), camera, { width: 10, height: 10 });
    expect(calls.filter((c) => c.startsWith('globalAlpha='))).toEqual([
      'globalAlpha=0.5',
      'globalAlpha=1',
      'globalAlpha=1',
    ]);
    expect(calls.at(-1)).toBe('globalAlpha=1');
  });

  it('arc and curve arguments are passed in full', () => {
    const { ctx, calls } = recordingContext();
    const curve = new PathShape({
      path: [
        { type: 'move', point: { x: 0 } },
        {
          type: 'bezier',
          control1: { x: 1, y: 2 },
          control2: { x: 3, y: 4 },
          point: { x: 5, y: 6 },
        },
      ],
      closed: false,
    });
    new CanvasRenderer().render(
      ctx,
      sceneWith(new PathShape({ position: { x: -40, y: 0, z: 0 }, style: { stroke: 4 } }), curve),
      camera,
      {
        width: 10,
        height: 10,
      },
    );
    expect(calls).toContain(`arc -40 0 2 0 ${Math.PI * 2} false`);
    expect(calls[calls.indexOf(`arc -40 0 2 0 ${Math.PI * 2} false`) + 1]).toBe('closePath');
    expect(calls).toContain('bezierCurveTo 1 2 3 4 5 6');
  });

  it('the cylinder side is drawn with butt caps, then round caps again', () => {
    const { ctx, calls } = recordingContext();
    new CanvasRenderer().render(
      ctx,
      sceneWith(
        new Cylinder({ rotation: euler.create(0, 1, 0) }),
        new PathShape({
          position: { x: 0, y: 0, z: 50 },
          path: [
            { type: 'move', point: {} },
            { type: 'line', point: { x: 5 } },
          ],
        }),
      ),
      camera,
      { width: 100, height: 100 },
    );
    const caps = calls.filter((c) => c.startsWith('lineCap='));
    expect(caps).toEqual(['lineCap=butt', 'lineCap=round']);
  });

  it('decal clipping: save, circle, clip, restore, then state is set again', () => {
    const { ctx, calls } = recordingContext();
    const head = new PathShape({ id: 'head', style: { stroke: 80, color: '#f60' } });
    const eye = new Rect({
      id: 'eye',
      width: 6,
      height: 6,
      sortMode: 'attached',
      position: { x: 0, y: 0, z: 30 },
      style: { color: '#f60', stroke: 2 },
    });
    head.add(eye);
    new CanvasRenderer().render(
      ctx,
      sceneWith(
        head,
        new Rect({ position: { x: 0, y: 0, z: 60 }, style: { color: '#f60', stroke: 2 } }),
      ),
      camera,
      { width: 100, height: 100 },
    );
    const save = calls.indexOf('save');
    expect(calls.slice(save, save + 4)).toEqual([
      'save',
      'beginPath',
      `arc 0 0 40 0 ${Math.PI * 2}`,
      'clip',
    ]);
    const restore = calls.indexOf('restore');
    expect(restore).toBeGreaterThan(save);
    // After restore the stroke color of the same shape is set again: the cache is reset.
    expect(calls.slice(restore).filter((c) => c === 'strokeStyle=#f60')).toHaveLength(1);
  });
});
