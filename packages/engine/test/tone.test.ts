import { describe, expect, it } from 'vitest';
import {
  Box,
  Camera,
  CanvasRenderer,
  type CanvasTarget,
  Capsule,
  DEFAULT_LIGHT,
  DisplayList,
  faceColor,
  GLCollector,
  type Node,
  PathShape,
  Rect,
  Scene,
  ShapeStyle,
  Sphere,
  STRIDE,
} from '../src/index.ts';

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

const toned = { color: '#808080', shadowColor: '#000000', highlightColor: '#ffffff' } as const;

/** The RGB of each instance of `kind` in the first opaque bucket, as [shadow, highlight, color]. */
function tones(scene: Scene, camera: Camera, kind: 'sphere' | 'capsule'): number[][][] {
  const bucket = new GLCollector().collect(scene, camera).layers[0]?.opaque[0];
  const buffer = bucket?.data[kind];
  const out: number[][][] = [];
  if (!buffer) return out;
  const stride = STRIDE[kind];
  for (let i = 0; i < buffer.length; i += stride) {
    const at = (o: number) => Array.from(buffer.data.subarray(i + o, i + o + 3));
    out.push([at(stride - 12), at(stride - 8), at(stride - 4)]);
  }
  return out;
}

const black = [0, 0, 0];
const white = [1, 1, 1];
const grey = [128 / 255, 128 / 255, 128 / 255].map((v) => Math.fround(v));

describe('toon shading', () => {
  it('picks a flat face tone by its normal and the thresholds', () => {
    const style = new ShapeStyle(() => {}, toned);
    const light = { x: 0, y: 0, z: 1 };
    expect(faceColor(style, 'base', 0, 0, 1, light)).toBe('#ffffff');
    expect(faceColor(style, 'base', 0, 0, -1, light)).toBe('#000000');
    expect(faceColor(style, 'base', 1, 0, 1, light)).toBe('base');
    // Without a shadow color a face in shadow keeps its base; a zero normal too.
    const plain = new ShapeStyle(() => {}, { color: '#808080' });
    expect(faceColor(plain, 'base', 0, 0, -1, light)).toBe('base');
    expect(faceColor(style, 'base', 0, 0, 0, light)).toBe('base');
  });

  it('keeps the camera light normalized, refuses a zero one and marks the change', () => {
    const camera = new Camera();
    expect(camera.light).toEqual(DEFAULT_LIGHT);
    expect(Math.hypot(DEFAULT_LIGHT.x, DEFAULT_LIGHT.y, DEFAULT_LIGHT.z)).toBeCloseTo(1, 12);
    const scene = sceneWith(camera);
    const version = scene.changeVersion;
    camera.light = { x: 0, y: 0, z: 2 };
    expect(camera.light).toEqual({ x: 0, y: 0, z: 1 });
    expect(scene.changeVersion).toBeGreaterThan(version);
    expect(() => {
      camera.light = { x: 0, y: 0, z: 0 };
    }).toThrow(/light must be a finite nonzero direction/);
    expect(camera.light).toEqual({ x: 0, y: 0, z: 1 });
    expect(() => new Camera({ light: { x: Number.NaN, y: 0, z: 1 } })).toThrow(RangeError);
  });

  it('gives WebGL spheres, capsules and lone strokes their tones; faces one tone by the normal', () => {
    const camera = new Camera({ light: { x: 0, y: 0, z: 1 } });
    const sphere = new Sphere({ diameter: 10, style: toned });
    const capsule = new Capsule({ length: 10, diameter: 4, style: toned });
    const line = new PathShape({
      path: [
        { type: 'move', point: { x: 0, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 0, z: 0 } },
      ],
      style: { ...toned, stroke: 2 },
    });
    expect(tones(sceneWith(sphere), camera, 'sphere')).toEqual([[black, white, grey]]);
    expect(tones(sceneWith(capsule), camera, 'capsule')).toEqual([[black, white, grey]]);
    expect(tones(sceneWith(line), camera, 'capsule')).toEqual([[black, white, grey]]);
    // A filled face facing the light squarely is all highlight, its edge stroke too.
    const face = new Rect({ width: 10, height: 10, style: { ...toned, fill: true, stroke: 2 } });
    const edges = tones(sceneWith(face), camera, 'capsule');
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) expect(edge).toEqual([white, white, white]);
    // Untoned shapes carry their base color three times.
    const plain = new Sphere({ diameter: 10, style: { color: '#808080' } });
    expect(tones(sceneWith(plain), camera, 'sphere')).toEqual([[grey, grey, grey]]);
    expect(new GLCollector().collect(sceneWith(), camera).light).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('colors each box face by its normal in the display list', () => {
    const light = { x: 0.6, y: 0.5, z: 0.62 };
    const camera = new Camera({ light });
    const box = new Box({
      width: 10,
      height: 10,
      depth: 10,
      style: { color: '#808080', shadowColor: '#000000', fill: true, stroke: 0 },
    });
    box.setRotationFromEuler({ x: -0.4, y: 0.4, z: 0, order: 'XYZ' } as never);
    const list = new DisplayList().build(sceneWith(box), camera);
    const origin = { x: 0, y: 0, z: 0 };
    const front = { x: 0, y: 0, z: 0 };
    let shaded = 0;
    for (let i = 0; i < list.count; i++) {
      const item = list.item(i);
      const face = item.node as Rect;
      // The face's normal in camera space, toward its front side.
      camera.toView(origin, face.localToWorld(origin, { x: 0, y: 0, z: 0 }));
      camera.toView(front, face.localToWorld(front, face.front));
      const n = { x: front.x - origin.x, y: front.y - origin.y, z: front.z - origin.z };
      const away = n.z >= 0 && n.x * light.x + n.y * light.y + n.z * light.z < 0;
      expect(item.color, face.id).toBe(away ? '#000000' : '#808080');
      if (away) shaded++;
    }
    expect(list.count).toBe(6);
    expect(shaded).toBeGreaterThan(0);
  });

  it('draws the shadow and highlight of a sphere and the bands of a capsule in Canvas 2D', () => {
    const calls: string[] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push(
          `${name} ${args.map((a) => (typeof a === 'number' ? a.toFixed(2) : a)).join(' ')}`.trim(),
        );
    const ctx = new Proxy(
      {},
      {
        get: (_, key: string) => record(key),
        set: (_, key: string, value) => {
          calls.push(`${key}=${value}`);
          return true;
        },
      },
    ) as CanvasTarget;
    const camera = new Camera({ light: { x: -0.6, y: 0, z: 0.8 } });
    const sphere = new Sphere({ diameter: 20, style: { ...toned, stroke: 0 } });
    new CanvasRenderer().render(ctx, sceneWith(sphere), camera, { width: 40, height: 40 });
    // The base circle, then the shadow (dark half and the terminator's ellipse), then the spot.
    expect(calls.filter((c) => c.startsWith('fillStyle='))).toEqual([
      'fillStyle=#808080',
      'fillStyle=#000000',
      'fillStyle=#ffffff',
    ]);
    // The terminator: an ellipse 10 × 0.8 = 8 across the light, 10 along it.
    expect(calls).toContain('ellipse 0.00 0.00 8.00 10.00 3.14 4.71 1.57 true');
    calls.length = 0;
    const capsule = new Capsule({ length: 20, diameter: 6, style: { ...toned, stroke: 0 } });
    capsule.setRotationFromEuler({ x: 0, y: Math.PI / 2, z: 0, order: 'XYZ' } as never);
    // Across the axis: light along it would leave no highlight (n·l stays at most 0.8).
    const across = new Camera({ light: { x: 0, y: -0.6, z: 0.8 } });
    new CanvasRenderer().render(ctx, sceneWith(capsule), across, { width: 40, height: 40 });
    // The shadow stroke, then the lit band and the highlight, clipped to the capsule.
    expect(calls.filter((c) => c.startsWith('strokeStyle='))).toEqual([
      'strokeStyle=#000000',
      'strokeStyle=#808080',
      'strokeStyle=#ffffff',
    ]);
    expect(calls).toContain('clip');
  });
});
