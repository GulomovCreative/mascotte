import { describe, expect, it } from 'vitest';
import {
  BLOB_SHADOW_DEFAULTS,
  BlobShadow,
  Box,
  Camera,
  CanvasRenderer,
  type CanvasTarget,
  Capsule,
  DisplayList,
  findProperty,
  GLCollector,
  type GLFrame,
  type Node,
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

/** The outline rings of a frame's first opaque bucket: [inner, outer, back] each. */
function rings(frame: GLFrame): number[][] {
  const buffer = frame.layers[0]?.opaque[0]?.data.ring;
  const out: number[][] = [];
  if (!buffer) return out;
  for (let i = 0; i < buffer.length; i += STRIDE.ring) {
    out.push(Array.from(buffer.data.subarray(i + 6, i + 9)));
  }
  return out;
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

  it('give WebGL rings: around a sphere and a capsule from their front, a tube from its axis, a face behind', () => {
    expect(rings(collect(new Sphere({ diameter: 10 })))).toEqual([]);
    // A sphere of radius 5: from 5 to 7, a pixel behind its front.
    expect(rings(collect(new Sphere({ diameter: 10, style: { ...ink, stroke: 0 } })))).toEqual([
      [5, 7, -4],
    ]);
    expect(
      rings(collect(new Capsule({ length: 10, diameter: 4, style: { ...ink, stroke: 0 } }))),
    ).toEqual([[2, 4, -1]]);
    const tube = new PathShape({
      path: [
        { type: 'move', point: { x: 0, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 10, z: 0 } },
      ],
      closed: false,
      style: { ...ink, stroke: 2 },
    });
    expect(rings(collect(tube))).toEqual([
      [1, 3, 1],
      [1, 3, 1],
    ]);
    // A filled triangle: its three edges, behind the whole band.
    const face = new PathShape({
      path: [
        { type: 'move', point: { x: 0, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 0, z: 0 } },
        { type: 'line', point: { x: 0, y: 10, z: 0 } },
      ],
      style: { ...ink, stroke: 2, fill: true },
    });
    expect(rings(collect(face))).toEqual([
      [1, 3, 3],
      [1, 3, 3],
      [1, 3, 3],
    ]);
  });

  it('are stroked wider just before the item in Canvas 2D, on cut parts too', () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_, key: string) => () => calls.push(key),
        set: (_, key: string, value) => {
          calls.push(`${key}=${value}`);
          return true;
        },
      },
    ) as CanvasTarget;
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
    // WebGL fills it, translucent, in its layer below.
    const frame = new GLCollector().collect(sceneWith(shadow), new Camera({ zoom: 2 }));
    expect(frame.layers[0]?.transparent[0]?.count('fill')).toBeGreaterThan(0);
  });
});
