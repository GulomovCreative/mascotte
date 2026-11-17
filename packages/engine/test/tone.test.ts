import { describe, expect, it } from 'vitest';
import {
  Animator,
  Box,
  Camera,
  CanvasRenderer,
  type CanvasTarget,
  Capsule,
  DEFAULT_LIGHT,
  DisplayList,
  faceColor,
  findProperty,
  GLCollector,
  type Node,
  PathShape,
  Rect,
  Scene,
  SHADOW_BELOW,
  ShapeStyle,
  Sphere,
  STRIDE,
} from '../src/index.ts';
import {
  capsuleProgram,
  coneProgram,
  cylinderProgram,
  fillProgram,
  hemisphereProgram,
  sphereProgram,
} from '../src/render/gl/shaders.ts';

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
    out.push([at(stride - 13), at(stride - 9), at(stride - 5)]);
  }
  return out;
}

/** A context that records each call (numbers to two decimals) and each assignment into `calls`. */
function recorder(calls: string[]): CanvasTarget {
  const format = (a: unknown) => (typeof a === 'number' ? a.toFixed(2) : a);
  return new Proxy(
    {},
    {
      get:
        (_, key: string) =>
        (...args: unknown[]) =>
          calls.push(`${key} ${args.map(format).join(' ')}`.trim()),
      set: (_, key: string, value) => {
        calls.push(`${key}=${value}`);
        return true;
      },
    },
  ) as CanvasTarget;
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
    const ctx = recorder(calls);
    const camera = new Camera({ light: { x: -0.6, y: 0, z: 0.8 } });
    const sphere = new Sphere({ diameter: 20, style: { ...toned, stroke: 0 } });
    new CanvasRenderer().render(ctx, sceneWith(sphere), camera, { width: 40, height: 40 });
    // The base circle, then the shadow (dark half and the terminator's ellipse), then the spot.
    expect(calls.filter((c) => c.startsWith('fillStyle='))).toEqual([
      'fillStyle=#808080',
      'fillStyle=#000000',
      'fillStyle=#ffffff',
    ]);
    // The terminator: an ellipse 10 × 0.8 = 8 along the light, 10 across it.
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

  it('ties each GL instance layout to its program attributes', () => {
    const programs = {
      sphere: sphereProgram,
      capsule: capsuleProgram,
      cylinder: cylinderProgram,
      hemisphere: hemisphereProgram,
      cone: coneProgram,
      fill: fillProgram,
    } as const;
    for (const [kind, program] of Object.entries(programs)) {
      const sizes = program.attributes.reduce((sum, [, size]) => sum + size, 0);
      // The color, four numbers, and the object number come last in every layout.
      expect(sizes + 5, kind).toBe(STRIDE[kind as keyof typeof programs]);
    }
    // Canvas 2D's sphere outline draws the terminator at n·l = 0.
    expect(SHADOW_BELOW).toBe(0);
  });

  it('redraws for a new light even with the camera outside the scene', () => {
    const camera = new Camera();
    const version = camera.projectionVersion;
    camera.light = { x: 1, y: 0, z: 1 };
    expect(camera.projectionVersion).toBeGreaterThan(version);
    const same = camera.projectionVersion;
    camera.light = { x: 2, y: 0, z: 2 };
    expect(camera.projectionVersion).toBe(same);
  });

  it('keeps the last light when an animation passes through zero', () => {
    const camera = new Camera({ id: 'eye' });
    const scene = sceneWith(camera);
    const animator = new Animator(scene);
    animator.addLayer({ name: 'light' }).play({
      duration: 1,
      loop: 'once',
      tracks: [
        {
          target: 'eye',
          property: 'light',
          keys: [
            { time: 0, value: { x: 1, y: 0, z: 0 } },
            { time: 1, value: { x: -1, y: 0, z: 0 } },
          ],
        },
      ],
    });
    animator.update(0.25);
    expect(camera.light.x).toBeCloseTo(1, 12);
    expect(() => animator.update(0.25)).not.toThrow();
    expect(camera.light.x).toBeCloseTo(1, 12);
    animator.update(0.25);
    expect(camera.light.x).toBeCloseTo(-1, 12);
    const property = findProperty(camera, 'light');
    expect(() => property?.set(camera, { x: 0, y: 0, z: 0 } as never)).not.toThrow();
  });

  it('shades points and lone strokes from either side, and stops when the tones go', () => {
    // A stroke whose front side turns away: a tube looks the same from behind.
    const camera = new Camera({ light: { x: 0, y: -0.6, z: 0.8 } });
    const line = new PathShape({
      path: [
        { type: 'move', point: { x: -10, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 0, z: 0 } },
      ],
      style: { ...toned, stroke: 4 },
    });
    line.setRotationFromEuler({ x: 0, y: Math.PI, z: 0, order: 'XYZ' } as never);
    expect(tones(sceneWith(line), camera, 'capsule')).toEqual([[black, white, grey]]);
    const scene = sceneWith(line);
    const list = new DisplayList();
    expect(list.build(scene, camera).item(0).shade).toBe('capsule');
    line.style.shadowColor = null;
    line.style.highlightColor = null;
    expect(list.build(scene, camera).item(0).shade).toBe('none');
    // A point turned away is still a shaded sphere, in both backends.
    const point = new PathShape({
      path: [{ type: 'move', point: { x: 0, y: 0, z: 0 } }],
      style: { ...toned, stroke: 10 },
    });
    point.setRotationFromEuler({ x: 0, y: Math.PI, z: 0, order: 'XYZ' } as never);
    expect(tones(sceneWith(point), camera, 'sphere')).toEqual([[black, white, grey]]);
    expect(new DisplayList().build(sceneWith(point), camera).item(0).shade).toBe('sphere');
    // A stroke seen end-on, and a capsule too, are spheres.
    const endOn = new PathShape({
      path: [
        { type: 'move', point: { x: 0, y: 0, z: -10 } },
        { type: 'line', point: { x: 0, y: 0, z: 10 } },
      ],
      style: { ...toned, stroke: 4 },
    });
    const capsule = new Capsule({ length: 10, diameter: 4, style: toned });
    const ends = new DisplayList().build(sceneWith(endOn, capsule), camera);
    expect([ends.item(0).shade, ends.item(1).shade]).toEqual(['sphere', 'sphere']);
  });

  it('keeps the shading on the parts of a cut capsule', () => {
    const camera = new Camera();
    const head = new Sphere({ diameter: 40, style: { color: '#808080', stroke: 0 } });
    // The arm crosses the head's central plane: part of it goes behind the head.
    const arm = new Capsule({
      length: 60,
      diameter: 8,
      position: { x: 25, y: 0, z: 0 },
      style: toned,
    });
    arm.setRotationFromEuler({ x: 0, y: 1, z: 0, order: 'XYZ' } as never);
    const list = new DisplayList().build(sceneWith(head, arm), camera);
    const parts: { shade: string; shadeX: number; x0: number }[] = [];
    for (let i = 0; i < list.count; i++) {
      const item = list.item(i);
      if (item.node === arm) {
        parts.push({ shade: item.shade, shadeX: item.shadeX, x0: item.path.data[0] ?? 0 });
      }
    }
    expect(parts.length).toBe(2);
    for (const part of parts) expect(part.shade).toBe('capsule');
    // Both parts shade by the whole axis, from their own ends.
    expect(parts[0]?.shadeX).toBe(parts[1]?.shadeX);
    expect(parts[0]?.x0).not.toBe(parts[1]?.x0);
  });

  it('balances save and restore around a shaded decal and draws its tones inside the clip', () => {
    const calls: string[] = [];
    const ctx = recorder(calls);
    const head = new Sphere({ diameter: 40, style: { color: '#808080', stroke: 0 } });
    head.add(
      new Sphere({
        diameter: 10,
        position: { x: 0, y: 0, z: 20 },
        sortMode: 'attached',
        style: { ...toned, stroke: 0 },
      }),
    );
    head.add(
      new Capsule({
        length: 10,
        diameter: 4,
        position: { x: 10, y: 0, z: 20 },
        rotation: { x: 0, y: 1.2, z: 0, order: 'XYZ' } as never,
        sortMode: 'attached',
        style: { ...toned, stroke: 0 },
      }),
    );
    new CanvasRenderer().render(ctx, sceneWith(head), new Camera(), { width: 80, height: 80 });
    const saves = calls.filter((c) => c === 'save').length;
    expect(saves).toBeGreaterThan(0);
    expect(calls.filter((c) => c === 'restore').length).toBe(saves);
  });

  it('shades a sphere lit along the view: no shadow in front, all shadow from behind', () => {
    const calls: string[] = [];
    const ctx = recorder(calls);
    const sphere = new Sphere({ diameter: 20, style: { ...toned, stroke: 0 } });
    const render = (z: number) => {
      calls.length = 0;
      const camera = new Camera({ light: { x: 0, y: 0, z } });
      new CanvasRenderer().render(ctx, sceneWith(sphere), camera, { width: 40, height: 40 });
      // After the base circle's fill, without the frame's closing reset.
      return calls.slice(calls.indexOf('fillStyle=#808080') + 2, -1);
    };
    // In front: an empty shadow, the spot in the middle (0.9 of the radius toward the viewer).
    expect(render(1)).toEqual([
      'beginPath',
      'closePath',
      'fillStyle=#000000',
      'fill',
      'beginPath',
      `ellipse 0.00 0.00 ${(10 * Math.sqrt(1 - 0.81)).toFixed(2)} ${(10 * Math.sqrt(1 - 0.81)).toFixed(2)} 0.00 0.00 6.28`,
      'fillStyle=#ffffff',
      'fill',
    ]);
    // From behind: the whole circle in shadow, no spot.
    expect(render(-1)).toEqual([
      'beginPath',
      'arc 0.00 0.00 10.00 0.00 6.28',
      'closePath',
      'fillStyle=#000000',
      'fill',
    ]);
  });
});
