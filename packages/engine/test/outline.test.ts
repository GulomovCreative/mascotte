import { describe, expect, it } from 'vitest';
import {
  BLOB_SHADOW_DEFAULTS,
  BlobShadow,
  Box,
  Bucket,
  Camera,
  CanvasRenderer,
  type CanvasTarget,
  Capsule,
  DisplayList,
  findProperty,
  GLCollector,
  type GLFrame,
  HitTester,
  type Node,
  OBJECT_STRIDE,
  PathShape,
  Scene,
  ScreenOp,
  Sphere,
  STRIDE,
} from '../src/index.ts';

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

const camera = new Camera();
const ink = { outline: 2, outlineColor: '#000000' } as const;

/** The objects of a frame (without object 0): outline width and color. */
function objects(frame: GLFrame): { width: number; color: number[] }[] {
  const out: { width: number; color: number[] }[] = [];
  const data = frame.objects.data;
  for (let o = OBJECT_STRIDE; o < frame.objects.length; o += OBJECT_STRIDE) {
    out.push({ width: data[o + 4] as number, color: Array.from(data.subarray(o, o + 4)) });
  }
  return out;
}

/** [stencil, decal, layer] of each object of a frame (without object 0). */
function places(frame: GLFrame): number[][] {
  const out: number[][] = [];
  const data = frame.objects.data;
  for (let o = OBJECT_STRIDE; o < frame.objects.length; o += OBJECT_STRIDE) {
    out.push(Array.from(data.subarray(o + 5, o + 8)));
  }
  return out;
}

/** The object numbers the primitives of a frame's first opaque bucket end with. */
function objectNumbers(frame: GLFrame): number[] {
  const bucket = frame.layers[0]?.opaque[0];
  const out: number[] = [];
  if (!bucket) return out;
  for (const kind of Object.keys(STRIDE) as (keyof typeof STRIDE)[]) {
    const data = bucket.data[kind];
    for (let i = STRIDE[kind] - 1; i < data.length; i += STRIDE[kind])
      out.push(data.data[i] as number);
  }
  return out;
}

/** A Canvas 2D context that records each method called and each property set into `calls`. */
function recorder(calls: string[]): CanvasTarget {
  return new Proxy(
    {},
    {
      get: (_, key: string) => () => calls.push(key),
      set: (_, key: string, value) => {
        calls.push(`${key}=${value}`);
        return true;
      },
    },
  ) as CanvasTarget;
}

function collect(...nodes: Node[]): GLFrame {
  return new GLCollector().collect(sceneWith(...nodes), camera);
}

describe('outlines', () => {
  it('are a style length, 0 by default, passed to the parts of a solid', () => {
    const sphere = new Sphere({ diameter: 10 });
    expect([sphere.style.outline, sphere.style.outlineColor]).toEqual([0, '#2b2b2b']);
    expect(() => {
      sphere.style.outline = -1;
    }).toThrow(RangeError);
    const box = new Box({ style: { ...ink, fill: true } });
    expect(box.children.length).toBe(6);
    for (const child of box.children) {
      expect((child as unknown as { style: { outline: number } }).style.outline).toBe(2);
    }
  });

  it('give WebGL objects their outline width on screen and color, and number every primitive', () => {
    expect(objects(collect(new Sphere({ diameter: 10 }))).map((object) => object.width)).toEqual([
      0,
    ]);
    expect(objects(collect(new Sphere({ diameter: 10, style: { ...ink, stroke: 0 } })))).toEqual([
      { width: 2, color: [0, 0, 0, 1] },
    ]);
    const tube = new PathShape({
      path: [
        { type: 'move', point: { x: 0, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 10, z: 0 } },
      ],
      closed: false,
      style: { ...ink, stroke: 2 },
    });
    const sphere = new Sphere({ diameter: 10, position: { x: 30, y: 0, z: 0 }, style: ink });
    const frame = collect(tube, sphere);
    expect(objects(frame).map((object) => object.width)).toEqual([2, 2]);
    // Every primitive of the tube and the sphere carries its object's number.
    expect(new Set(objectNumbers(frame))).toEqual(new Set([1, 2]));
    // A decal knows its anchor's stencil number; a translucent shape has no outline.
    const head = new Sphere({ diameter: 40, style: ink });
    head.add(
      new Sphere({
        diameter: 8,
        position: { x: 0, y: 0, z: 20 },
        sortMode: 'attached',
        style: ink,
      }),
    );
    expect(places(collect(head))).toEqual([
      [1, 0, 0],
      [1, 1, 0],
    ]);
    const ghost = new Sphere({ diameter: 10, opacity: 0.5, style: ink });
    expect(objects(collect(ghost)).map((object) => object.width)).toEqual([0]);
    // Emitted for hit-testing, a shape is no object.
    const bucket = new Bucket();
    new GLCollector().emitDrawable(sphere, camera, bucket);
    expect(bucket.data.sphere.data[STRIDE.sphere - 1]).toBe(0);
  });

  it('are stroked wider just before the item in Canvas 2D, on cut parts too', () => {
    const calls: string[] = [];
    const ctx = recorder(calls);
    const sphere = new Sphere({ diameter: 10, style: { ...ink, stroke: 0, color: '#ff0000' } });
    new CanvasRenderer().render(ctx, sceneWith(sphere), camera, { width: 40, height: 40 });
    // The circle stroked 2 wider on each side in the outline's color, then filled in its own.
    const outline = calls.indexOf('strokeStyle=#000000');
    expect(calls.slice(outline - 1, outline + 2)).toEqual([
      'lineWidth=4',
      'strokeStyle=#000000',
      'stroke',
    ]);
    expect(calls.indexOf('fillStyle=#ff0000')).toBeGreaterThan(outline);
    // A capsule cut by a sphere: both parts keep the outline.
    const head = new Sphere({ diameter: 40, style: { stroke: 0 } });
    const arm = new Capsule({
      length: 60,
      diameter: 8,
      position: { x: 25, y: 0, z: 0 },
      style: ink,
    });
    arm.setRotationFromEuler({ x: 0, y: 1, z: 0, order: 'XYZ' } as never);
    const list = new DisplayList().build(sceneWith(head, arm), camera);
    const widths: number[] = [];
    for (let i = 0; i < list.count; i++) {
      if (list.item(i).node === arm) widths.push(list.item(i).outlineWidth);
    }
    expect(widths).toHaveLength(2);
    for (const width of widths) expect(width).toBeCloseTo(2, 9);
  });
});

describe('outline details', () => {
  it('widen a stroke by the outline on both sides in Canvas 2D', () => {
    const calls: string[] = [];
    const ctx = recorder(calls);
    const tube = new PathShape({
      path: [
        { type: 'move', point: { x: -10, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 0, z: 0 } },
      ],
      closed: false,
      style: { ...ink, stroke: 10, color: '#ff0000' },
    });
    new CanvasRenderer().render(ctx, sceneWith(tube), camera, { width: 40, height: 40 });
    const outline = calls.indexOf('strokeStyle=#000000');
    expect(calls.slice(outline - 1, outline + 1)).toEqual(['lineWidth=14', 'strokeStyle=#000000']);
    expect(calls).toContain('lineWidth=10');
  });
});

describe('BlobShadow', () => {
  it('lies below everything, faint and black, a third as high as wide unless told', () => {
    const shadow = new BlobShadow({ width: 60 });
    expect([shadow.opacity, shadow.sortMode, shadow.layer]).toEqual([0.2, 'layer', -1]);
    expect([shadow.width, shadow.squash]).toEqual([60, 1 / 3]);
    expect([shadow.style.color, shadow.style.fill, shadow.style.stroke]).toEqual([
      '#000000',
      true,
      0,
    ]);
    const own = new BlobShadow({ width: 60, squash: 0.25, opacity: 0.5, layer: -2 });
    expect([own.squash, own.opacity, own.layer]).toEqual([0.25, 0.5, -2]);
    // The registry knows its defaults.
    for (const name of ['opacity', 'sortMode', 'layer'] as const) {
      expect(findProperty(BlobShadow, name)?.default).toBe(BLOB_SHADOW_DEFAULTS[name]);
    }
    expect(findProperty(BlobShadow, 'squash')?.default).toBeCloseTo(1 / 3, 12);
  });

  it('faces the camera however it is turned: an ellipse of its width and height on screen', () => {
    const shadow = new BlobShadow({ width: 60, position: { x: 10, y: 30, z: 0 } });
    shadow.setRotationFromEuler({ x: 1.2, y: 0.7, z: 0, order: 'XYZ' } as never);
    const item = new DisplayList().build(sceneWith(shadow), new Camera({ zoom: 2 })).item(0);
    const { ops, opCount, data } = item.path;
    expect(Array.from(ops.subarray(0, opCount))).toEqual([
      ScreenOp.move,
      ScreenOp.cubic,
      ScreenOp.cubic,
      ScreenOp.cubic,
      ScreenOp.cubic,
    ]);
    // From the right end (center 20, 60 at zoom 2; radii 60 and 20) round to it again.
    const at = (i: number) => [data[i] ?? 0, data[i + 1] ?? 0].map((v) => Number(v.toFixed(9)));
    expect(at(0)).toEqual([80, 60]);
    expect(at(6)).toEqual([20, 80]);
    expect([item.hasFill, item.opacity]).toEqual([true, 0.2]);
    // WebGL fills the same ellipse, translucent, in its layer below.
    const frame = new GLCollector().collect(sceneWith(shadow), new Camera({ zoom: 2 }));
    const fill = frame.layers[0]?.transparent[0]?.data.fill;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; fill && i < fill.length; i += STRIDE.fill) {
      xs.push(fill.data[i] as number);
      ys.push(fill.data[i + 1] as number);
    }
    expect([Math.min(...xs), Math.max(...xs)].map(Math.round)).toEqual([-40, 80]);
    expect([Math.min(...ys), Math.max(...ys)].map((v) => Math.round(v))).toEqual([40, 80]);
  });

  it('draws only its color, and the pointer passes through it', () => {
    const shadow = new BlobShadow({ width: 60, style: { stroke: 5, fill: false } });
    const item = new DisplayList().build(sceneWith(shadow), camera).item(0);
    expect([item.hasFill, item.hasStroke]).toEqual([true, false]);
    const viewport = { width: 100, height: 100 };
    const scene = sceneWith(shadow);
    expect(new HitTester().hitTest(scene, camera, viewport, 50, 50)).toBeNull();
    const ball = new Sphere({ diameter: 10 });
    scene.root.add(ball);
    expect(new HitTester().hitTest(scene, camera, viewport, 50, 50)?.node).toBe(ball);
  });
});
