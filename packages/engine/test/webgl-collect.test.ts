import { euler } from '@mascotte/math';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Box,
  type Bucket,
  Camera,
  Capsule,
  Cone,
  Cylinder,
  decalAnchor,
  Ellipse,
  GLCollector,
  type GLFrame,
  type GLLayer,
  Hemisphere,
  IndexBuffer,
  MAX_ANCHORS,
  Node,
  PathShape,
  PIXEL_BUDGET,
  type PrimitiveKind,
  Rect,
  Scene,
  Sphere,
  STRIDE,
  supersampleFor,
  triangulate,
} from '../src/index.ts';

const camera = new Camera();

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

function instances(bucket: Bucket | undefined, kind: PrimitiveKind): number[][] {
  if (!bucket) return [];
  const buffer = bucket.data[kind];
  const stride = STRIDE[kind];
  const out: number[][] = [];
  for (let i = 0; i < buffer.length; i += stride)
    out.push(Array.from(buffer.data.subarray(i, i + stride)));
  return out;
}

function first(frame: GLFrame): GLLayer {
  const layer = frame.layers[0];
  if (!layer) throw new Error('The frame has no layers.');
  return layer;
}

function area(xs: number[], ys: number[], triangles: number[]): number {
  let sum = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const [a = 0, b = 0, c = 0] = triangles.slice(i, i + 3);
    sum += Math.abs(
      ((xs[b] ?? 0) - (xs[a] ?? 0)) * ((ys[c] ?? 0) - (ys[a] ?? 0)) -
        ((ys[b] ?? 0) - (ys[a] ?? 0)) * ((xs[c] ?? 0) - (xs[a] ?? 0)),
    );
  }
  return sum / 2;
}

/** Triangle indices from the buffer as an array. */
function ids(out: IndexBuffer): number[] {
  return Array.from(out.data.subarray(0, out.length));
}

describe('triangulate', () => {
  it('convex and concave polygons are covered without area loss', () => {
    const out = new IndexBuffer();
    expect(triangulate([0, 10, 10, 0], [0, 0, 10, 10], 4, out)).toBe(2);
    expect(area([0, 10, 10, 0], [0, 0, 10, 10], ids(out))).toBeCloseTo(100, 9);
    // An L shape: area 75.
    const xs = [0, 10, 10, 5, 5, 0];
    const ys = [0, 0, 5, 5, 10, 10];
    expect(triangulate(xs, ys, 6, out)).toBe(4);
    expect(area(xs, ys, ids(out))).toBeCloseTo(75, 9);
    // Clockwise winding works too.
    expect(triangulate([0, 0, 10, 10], [0, 10, 10, 0], 4, out)).toBe(2);
    expect(triangulate([0, 1], [0, 1], 2, out)).toBe(0);
  });

  it('degenerate contours do not break triangulation: indices in range, no area lost', () => {
    const out = new IndexBuffer();
    // All points on one line: zero area.
    triangulate([0, 5, 10, 15], [0, 0, 0, 0], 4, out);
    expect(area([0, 5, 10, 15], [0, 0, 0, 0], ids(out))).toBeCloseTo(0, 9);
    // Repeated vertices.
    const xs = [0, 10, 10, 10, 0];
    const ys = [0, 0, 0, 10, 10];
    triangulate(xs, ys, 5, out);
    expect(ids(out).every((i) => i >= 0 && i < 5)).toBe(true);
    expect(area(xs, ys, ids(out))).toBeCloseTo(100, 9);
    // A self-intersecting bow tie: triangulation finishes, indices in range.
    const n = triangulate([0, 10, 0, 10], [0, 10, 10, 0], 4, out);
    expect(out.length).toBe(n * 3);
    expect(ids(out).every((i) => i >= 0 && i < 4)).toBe(true);
  });
});

describe('scratch buffer growth', () => {
  it('a polygon larger than the initial ring triangulates without loss', () => {
    const n = 100;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < n; i++) {
      xs.push(Math.cos((i / n) * Math.PI * 2) * 50);
      ys.push(Math.sin((i / n) * Math.PI * 2) * 50);
    }
    const out = new IndexBuffer();
    expect(triangulate(xs, ys, n, out)).toBe(n - 2);
    expect(ids(out).every((i) => i >= 0 && i < n)).toBe(true);
    // Regular polygon area: n · r² · sin(2π/n) / 2.
    expect(area(xs, ys, ids(out))).toBeCloseTo((n * 2500 * Math.sin((2 * Math.PI) / n)) / 2, 6);
  });

  it('a 200-point path: the polyline grows, all segments are in place', () => {
    const path: { type: 'move' | 'line'; point: { x: number; y: number } }[] = [];
    for (let i = 0; i < 200; i++) {
      path.push({ type: i === 0 ? 'move' : 'line', point: { x: i - 100, y: (i % 2) * 3 } });
    }
    const frame = new GLCollector().collect(
      sceneWith(new PathShape({ path, closed: false, style: { stroke: 2, fill: false } })),
      camera,
    );
    const capsules = instances(first(frame).opaque[0], 'capsule');
    expect(capsules).toHaveLength(199);
    for (const [i, c] of capsules.entries()) {
      expect(c.slice(0, 2)).toEqual([i - 100, (i % 2) * 3]);
      expect(c.slice(3, 5)).toEqual([i + 1 - 100, ((i + 1) % 2) * 3]);
    }
  });
});

describe('GLCollector', () => {
  it('a point is a ball, a line is a capsule, a closed rect is four capsules', () => {
    const frame = new GLCollector().collect(
      sceneWith(
        new PathShape({ position: { x: 5, y: 0, z: 0 }, style: { stroke: 10 } }),
        new PathShape({
          path: [
            { type: 'move', point: { x: -5 } },
            { type: 'line', point: { x: 5 } },
          ],
          style: { stroke: 4 },
        }),
        new Rect({ width: 10, height: 6, style: { stroke: 2 } }),
      ),
      new Camera({ zoom: 2 }),
    );
    const plain = first(frame).opaque[0];
    expect(instances(plain, 'sphere').map((s) => s.slice(0, 4))).toEqual([[10, 0, 0, 10]]);
    const capsules = instances(plain, 'capsule');
    expect(capsules).toHaveLength(5);
    expect(capsules[0]?.slice(0, 7)).toEqual([-10, 0, 0, 10, 0, 0, 4]);
  });

  it('fill is split into triangles, a curve into segments', () => {
    const frame = new GLCollector().collect(
      sceneWith(
        new Rect({ width: 10, height: 6, style: { fill: true, stroke: 0 } }),
        new Ellipse({ diameter: 40 }),
      ),
      camera,
    );
    const plain = first(frame).opaque[0];
    expect(plain?.count('fill')).toBe(6);
    // Four 9/16 arc quarters give curves: each splits into several segments.
    expect(plain?.count('capsule')).toBeGreaterThan(8);
  });

  it('back side: hidden or its own color', () => {
    const turned = euler.create(0, Math.PI, 0);
    const frame = new GLCollector().collect(
      sceneWith(
        new Rect({ rotation: turned, style: { backfaceVisible: false } }),
        new Rect({ rotation: turned, style: { color: '#000', backfaceColor: '#ff0000' } }),
      ),
      camera,
    );
    const capsules = instances(first(frame).opaque[0], 'capsule');
    expect(capsules).toHaveLength(4);
    expect(capsules[0]?.slice(7)).toEqual([1, 0, 0, 1]);
  });

  it('decals go in their own bucket with the anchor number, the anchor has the same number', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    const eye = new Node({ sortMode: 'attached', position: { x: 0, y: 0, z: 36 } });
    eye.add(new PathShape({ id: 'white', style: { stroke: 10 } }));
    head.add(eye);
    head.add(new PathShape({ id: 'mouth', sortMode: 'attached', style: { stroke: 4 } }));
    expect(decalAnchor(eye.children[0] as Node)).toBe(head);
    const frame = new GLCollector().collect(sceneWith(head, new Sphere()), camera);
    const anchor = first(frame).opaque.find((b) => b.stencil === 1);
    expect(anchor?.count('sphere')).toBe(1);
    expect(first(frame).opaque[0]?.stencil).toBe(0);
    expect(first(frame).opaque[0]?.count('sphere')).toBe(1);
    // Each decal is its own bucket in sort order.
    expect(first(frame).decals.map((b) => [b.stencil, b.count('sphere')])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it('for a solid the anchor is the solid itself, its parts are in the anchor bucket', () => {
    const head = new Hemisphere({ id: 'head', diameter: 40 });
    head.add(
      new PathShape({
        id: 'eye',
        sortMode: 'attached',
        position: { x: 0, y: 0, z: 10 },
        style: { stroke: 5 },
      }),
    );
    const frame = new GLCollector().collect(sceneWith(head), camera);
    const anchor = first(frame).opaque.find((b) => b.stencil === 1);
    expect(anchor?.count('hemisphere')).toBe(1);
    expect(first(frame).decals[0]?.count('sphere')).toBe(1);
  });

  it('translucent items go in a separate bucket in order, with opacity in the color', () => {
    const frame = new GLCollector().collect(
      sceneWith(
        new PathShape({ opacity: 0.5, style: { stroke: 4, color: '#ffffff' } }),
        new PathShape({ opacity: 0 }),
      ),
      camera,
    );
    expect(first(frame).transparent).toHaveLength(1);
    expect(instances(first(frame).transparent[0], 'sphere')[0]?.slice(4)).toEqual([1, 1, 1, 0.5]);
  });

  it('volume primitives: ball, capsule, dome, cylinder side, cone', () => {
    const frame = new GLCollector().collect(
      sceneWith(
        new Sphere({ diameter: 10 }),
        new Capsule({ length: 20, diameter: 6 }),
        new Hemisphere({ diameter: 10 }),
        new Cylinder({ diameter: 10, length: 20 }),
        new Cone({ diameter: 10, length: 20 }),
      ),
      camera,
    );
    const counts = (kind: PrimitiveKind) =>
      first(frame).opaque.reduce((n, b) => n + b.count(kind), 0);
    expect([counts('sphere'), counts('hemisphere'), counts('cylinder'), counts('cone')]).toEqual([
      1, 1, 1, 1,
    ]);
    // One capsule; cylinder, cone and hemisphere caps are solid disks without edge tubes.
    expect(counts('capsule')).toBe(1);
    expect(counts('fill')).toBeGreaterThan(0);
    // Ball radius is half the diameter plus half the stroke.
    expect(instances(first(frame).opaque[0], 'sphere')[0]?.[3]).toBe(5.5);
  });

  it('the depth range covers the primitives, perspective scales', () => {
    const frame = new GLCollector().collect(
      sceneWith(
        new Sphere({ diameter: 10, position: { x: 0, y: 0, z: 30 } }),
        new Sphere({ diameter: 10, position: { x: 0, y: 0, z: -40 } }),
      ),
      camera,
    );
    expect(frame.zMin).toBeLessThanOrEqual(-45);
    expect(frame.zMax).toBeGreaterThanOrEqual(35);
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    const near = new GLCollector().collect(
      sceneWith(
        new Sphere({ diameter: 10, style: { stroke: 0 }, position: { x: 0, y: 0, z: 50 } }),
      ),
      perspective,
    );
    expect(instances(first(near).opaque[0], 'sphere')[0]?.[3]).toBeCloseTo(10, 9);
  });

  it('buckets and buffers are reused between frames', () => {
    const scene = sceneWith(new Rect(), new Sphere());
    const collector = new GLCollector();
    const one = first(collector.collect(scene, camera)).opaque[0];
    const data = one?.data.capsule.data;
    const two = first(collector.collect(scene, camera)).opaque[0];
    expect(two).toBe(one);
    expect(two?.data.capsule.data).toBe(data);
  });

  it('caps are full-radius disks, box faces are inflated by half the stroke width', () => {
    const cylinder = new Cylinder({ diameter: 20, length: 10, style: { stroke: 4 } });
    const frame = new GLCollector().collect(sceneWith(cylinder), camera);
    const fills = first(frame).opaque.flatMap((b) => instances(b, 'fill'));
    const radii = fills.map(([x = 0, y = 0]) => Math.hypot(x, y));
    // Cap radius = side radius: (20 + 4) / 2.
    expect(Math.max(...radii)).toBeCloseTo(12, 6);
    const body = first(frame).opaque.flatMap((b) => instances(b, 'cylinder'))[0];
    expect(body?.[6]).toBeCloseTo(12, 9);

    const box = new Box({ width: 10, height: 10, depth: 10, style: { stroke: 2 } });
    const boxFrame = new GLCollector().collect(sceneWith(box), camera);
    const corners = first(boxFrame).opaque.flatMap((b) => instances(b, 'fill'));
    expect(Math.max(...corners.map(([x = 0]) => x))).toBeCloseTo(6, 9);
    expect(first(boxFrame).opaque.reduce((n, b) => n + b.count('capsule'), 0)).toBe(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('empty scene: no layers, a finite depth range', () => {
    const frame = new GLCollector().collect(new Scene(), camera);
    expect(frame.layers).toHaveLength(0);
    expect([frame.zMin, frame.zMax]).toEqual([-1, 1]);
  });

  it('a shape behind the camera eye in perspective is not drawn and does not extend the range', () => {
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    const frame = new GLCollector().collect(
      sceneWith(new Sphere({ diameter: 10, position: { x: 0, y: 0, z: 150 } })),
      perspective,
    );
    const total = frame.layers.reduce(
      (n, layer) => n + layer.opaque.reduce((m, b) => m + b.count('sphere'), 0),
      0,
    );
    expect(total).toBe(0);
    expect([frame.zMin, frame.zMax]).toEqual([-1, 1]);
  });

  it('sort layers are separate frame layers: the lower one first even if closer', () => {
    const shadow = new PathShape({
      sortMode: 'layer',
      layer: -1,
      position: { x: 0, y: 0, z: 50 },
      style: { stroke: 10 },
    });
    const body = new Sphere({ diameter: 20 });
    const badge = new PathShape({ sortMode: 'layer', layer: 1, style: { stroke: 4 } });
    const frame = new GLCollector().collect(sceneWith(badge, body, shadow), camera);
    expect(frame.layers).toHaveLength(3);
    const spheres = frame.layers.map((layer) => instances(layer.opaque[0], 'sphere'));
    expect(spheres[0]?.[0]?.[2]).toBe(50);
    expect(spheres[1]?.[0]?.[3]).toBe(10.5);
    expect(spheres[2]?.[0]?.[3]).toBe(2);
  });

  it('with a translucent anchor decals are drawn as regular translucent shapes', () => {
    const head = new PathShape({ opacity: 0.5, style: { stroke: 40 } });
    head.add(new PathShape({ sortMode: 'attached', position: { x: 0, y: 0, z: 18 } }));
    const layer = first(new GLCollector().collect(sceneWith(head), camera));
    expect(layer.decals).toHaveLength(0);
    expect(layer.transparent).toHaveLength(2);
  });

  it('a translucent decal on an opaque anchor gets its own blended bucket', () => {
    const head = new PathShape({ style: { stroke: 40 } });
    head.add(new PathShape({ sortMode: 'attached', position: { x: 0, y: 0, z: 18 } }));
    head.add(
      new PathShape({ sortMode: 'attached', opacity: 0.5, position: { x: 0, y: 0, z: 19 } }),
    );
    const layer = first(new GLCollector().collect(sceneWith(head), camera));
    expect(layer.decals.map((b) => [b.stencil, b.blend])).toEqual([
      [1, false],
      [1, true],
    ]);
  });

  it(`beyond ${MAX_ANCHORS} anchors in a layer decals become regular shapes with a warning`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heads: Node[] = [];
    for (let i = 0; i <= MAX_ANCHORS; i++) {
      const head = new PathShape({ position: { x: i, y: 0, z: 0 }, style: { stroke: 4 } });
      head.add(new PathShape({ sortMode: 'attached', style: { stroke: 1 } }));
      heads.push(head);
    }
    const collector = new GLCollector();
    const layer = first(collector.collect(sceneWith(...heads), camera));
    expect(layer.decals).toHaveLength(MAX_ANCHORS);
    expect(Math.max(...layer.decals.map((b) => b.stencil))).toBe(MAX_ANCHORS);
    collector.collect(sceneWith(...heads), camera);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('an unparsable color becomes magenta with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shape = () => new PathShape({ style: { stroke: 2, color: 'not-a-color-for-test' } });
    const frame = new GLCollector().collect(sceneWith(shape(), shape()), camera);
    expect(instances(first(frame).opaque[0], 'sphere')[0]?.slice(4)).toEqual([1, 0, 1, 1]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('curves are split finely and accurately: ellipse points lie at its radius', () => {
    const frame = new GLCollector().collect(sceneWith(new Ellipse({ diameter: 200 })), camera);
    const capsules = instances(first(frame).opaque[0], 'capsule');
    // About 3 pixels per segment: circumference ≈ 628.
    expect(capsules.length).toBeGreaterThan(150);
    // Arcs are cubic curves with 9/16 handles, as in Zdog: they deviate from the circle
    // by up to 0.6% of the radius, the split points themselves lie on the curves.
    for (const [ax = 0, ay = 0] of capsules) {
      expect(Math.abs(Math.hypot(ax, ay) - 100)).toBeLessThan(0.7);
    }
  });

  it('a path with several contours fills only the first, strokes all', () => {
    const frame = new GLCollector().collect(
      sceneWith(
        new PathShape({
          path: [
            { type: 'move', point: { x: 0, y: 0 } },
            { type: 'line', point: { x: 10, y: 0 } },
            { type: 'line', point: { x: 10, y: 10 } },
            { type: 'move', point: { x: 20, y: 0 } },
            { type: 'line', point: { x: 30, y: 0 } },
            { type: 'line', point: { x: 30, y: 10 } },
          ],
          style: { stroke: 2, fill: true },
        }),
      ),
      camera,
    );
    const plain = first(frame).opaque[0];
    expect(plain?.count('fill')).toBe(3);
    // The path is closed by default: both contours are triangles of three segments.
    expect(plain?.count('capsule')).toBe(6);
  });

  it('all box faces meet at the corners of the inflated box', () => {
    const box = new Box({ width: 10, height: 10, depth: 10, style: { stroke: 2 } });
    const layer = first(new GLCollector().collect(sceneWith(box), camera));
    const vertices = layer.opaque.flatMap((b) => instances(b, 'fill'));
    expect(vertices.length).toBeGreaterThan(0);
    for (const [x = 0, y = 0, z = 0] of vertices) {
      expect([Math.abs(x), Math.abs(y), Math.abs(z)].map((v) => Math.round(v * 1e6) / 1e6)).toEqual(
        [6, 6, 6],
      );
    }
  });

  it('cone and hemisphere caps are disks with the base radius plus half the stroke width', () => {
    for (const solid of [
      new Cone({ diameter: 20, length: 10, style: { stroke: 4 } }),
      new Hemisphere({ diameter: 20, style: { stroke: 4 } }),
    ]) {
      const layer = first(new GLCollector().collect(sceneWith(solid), camera));
      const radii = layer.opaque
        .flatMap((b) => instances(b, 'fill'))
        .map(([x = 0, y = 0]) => Math.hypot(x, y));
      expect(Math.max(...radii)).toBeCloseTo(12, 6);
    }
  });

  it('when the bucket count changes between frames old data does not leak', () => {
    const head = new PathShape({ style: { stroke: 40 } });
    const eye = new PathShape({ sortMode: 'attached', position: { x: 0, y: 0, z: 18 } });
    head.add(eye);
    const scene = sceneWith(head, new Sphere({ opacity: 0.5 }));
    const collector = new GLCollector();
    const before = first(collector.collect(scene, camera));
    expect([before.opaque.length, before.decals.length, before.transparent.length]).toEqual([
      2, 1, 1,
    ]);
    head.remove(eye);
    const after = first(collector.collect(scene, camera));
    expect([after.opaque.length, after.decals.length, after.transparent.length]).toEqual([1, 0, 1]);
    expect(after.opaque[0]?.count('sphere')).toBe(1);
    expect(after.transparent[0]?.count('sphere')).toBe(1);
  });
});

describe('supersampleFor', () => {
  it('lowers the ratio to fit GPU limits and the pixel budget', () => {
    expect(supersampleFor(800, 600, 2, 16384)).toBe(2);
    // Full HD at density 2: at 2× the frame would exceed the budget.
    expect(3840 * 2160 * 4).toBeGreaterThan(PIXEL_BUDGET);
    expect(supersampleFor(3840, 2160, 2, 16384)).toBe(1);
    expect(supersampleFor(3000, 100, 4, 8192)).toBe(2);
    expect(() => supersampleFor(9000, 100, 2, 8192)).toThrow(RangeError);
  });
});
