import { euler } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
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
  Hemisphere,
  Node,
  PathShape,
  type PrimitiveKind,
  Rect,
  Scene,
  Sphere,
  STRIDE,
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

describe('triangulate', () => {
  it('выпуклый и невыпуклый многоугольники покрываются без потерь площади', () => {
    const out: number[] = [];
    expect(triangulate([0, 10, 10, 0], [0, 0, 10, 10], 4, out)).toBe(2);
    expect(area([0, 10, 10, 0], [0, 0, 10, 10], out)).toBeCloseTo(100, 9);
    // Буква «Г»: площадь 75.
    const xs = [0, 10, 10, 5, 5, 0];
    const ys = [0, 0, 5, 5, 10, 10];
    expect(triangulate(xs, ys, 6, out)).toBe(4);
    expect(area(xs, ys, out)).toBeCloseTo(75, 9);
    // Обход по часовой стрелке тоже работает.
    expect(triangulate([0, 0, 10, 10], [0, 10, 10, 0], 4, out)).toBe(2);
    expect(triangulate([0, 1], [0, 1], 2, out)).toBe(0);
  });
});

describe('GLCollector', () => {
  it('точка — шар, отрезок — капсула, замкнутый прямоугольник — четыре капсулы', () => {
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
    const plain = frame.opaque[0];
    expect(instances(plain, 'sphere').map((s) => s.slice(0, 4))).toEqual([[10, 0, 0, 10]]);
    const capsules = instances(plain, 'capsule');
    expect(capsules).toHaveLength(5);
    expect(capsules[0]?.slice(0, 7)).toEqual([-10, 0, 0, 10, 0, 0, 4]);
  });

  it('заливка разбивается на треугольники, кривая — на отрезки', () => {
    const frame = new GLCollector().collect(
      sceneWith(
        new Rect({ width: 10, height: 6, style: { fill: true, stroke: 0 } }),
        new Ellipse({ diameter: 40 }),
      ),
      camera,
    );
    const plain = frame.opaque[0];
    expect(plain?.count('fill')).toBe(6);
    // Четыре четверти дуги по 9/16 дают кривые: каждая на несколько отрезков.
    expect(plain?.count('capsule')).toBeGreaterThan(8);
  });

  it('обратная сторона: скрыта или своего цвета', () => {
    const turned = euler.create(0, Math.PI, 0);
    const frame = new GLCollector().collect(
      sceneWith(
        new Rect({ rotation: turned, style: { backfaceVisible: false } }),
        new Rect({ rotation: turned, style: { color: '#000', backfaceColor: '#ff0000' } }),
      ),
      camera,
    );
    const capsules = instances(frame.opaque[0], 'capsule');
    expect(capsules).toHaveLength(4);
    expect(capsules[0]?.slice(7)).toEqual([1, 0, 0, 1]);
  });

  it('декали — в своей корзине с номером опоры, опора — с тем же номером', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    const eye = new Node({ sortMode: 'attached', position: { x: 0, y: 0, z: 36 } });
    eye.add(new PathShape({ id: 'white', style: { stroke: 10 } }));
    head.add(eye);
    head.add(new PathShape({ id: 'mouth', sortMode: 'attached', style: { stroke: 4 } }));
    expect(decalAnchor(eye.children[0] as Node)).toBe(head);
    const frame = new GLCollector().collect(sceneWith(head, new Sphere()), camera);
    const anchor = frame.opaque.find((b) => b.stencil === 1);
    expect(anchor?.count('sphere')).toBe(1);
    expect(frame.opaque[0]?.stencil).toBe(0);
    expect(frame.opaque[0]?.count('sphere')).toBe(1);
    expect(frame.decals).toHaveLength(1);
    expect(frame.decals[0]?.stencil).toBe(1);
    expect(frame.decals[0]?.count('sphere')).toBe(2);
  });

  it('у составной фигуры опора — сама фигура, её части в корзине опоры', () => {
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
    const anchor = frame.opaque.find((b) => b.stencil === 1);
    expect(anchor?.count('hemisphere')).toBe(1);
    expect(frame.decals[0]?.count('sphere')).toBe(1);
  });

  it('полупрозрачное — отдельной корзиной по порядку, с непрозрачностью в цвете', () => {
    const frame = new GLCollector().collect(
      sceneWith(
        new PathShape({ opacity: 0.5, style: { stroke: 4, color: '#ffffff' } }),
        new PathShape({ opacity: 0 }),
      ),
      camera,
    );
    expect(frame.transparent).toHaveLength(1);
    expect(instances(frame.transparent[0], 'sphere')[0]?.slice(4)).toEqual([1, 1, 1, 0.5]);
  });

  it('объёмные примитивы: шар, капсула, купол, бок цилиндра, конус', () => {
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
    const counts = (kind: PrimitiveKind) => frame.opaque.reduce((n, b) => n + b.count(kind), 0);
    expect([counts('sphere'), counts('hemisphere'), counts('cylinder'), counts('cone')]).toEqual([
      1, 1, 1, 1,
    ]);
    // Капсула — одна; крышки цилиндра, конуса и полусферы — сплошные диски без трубок по краю.
    expect(counts('capsule')).toBe(1);
    expect(counts('fill')).toBeGreaterThan(0);
    // Радиус шара — половина диаметра плюс половина обводки.
    expect(instances(frame.opaque[0], 'sphere')[0]?.[3]).toBe(5.5);
  });

  it('диапазон глубин охватывает примитивы, перспектива масштабирует', () => {
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
    expect(instances(near.opaque[0], 'sphere')[0]?.[3]).toBeCloseTo(10, 9);
  });

  it('корзины и буферы переиспользуются между кадрами', () => {
    const scene = sceneWith(new Rect(), new Sphere());
    const collector = new GLCollector();
    const first = collector.collect(scene, camera).opaque[0];
    const data = first?.data.capsule.data;
    const second = collector.collect(scene, camera).opaque[0];
    expect(second).toBe(first);
    expect(second?.data.capsule.data).toBe(data);
  });

  it('крышки — диски полного радиуса, грани коробки — раздутые на полтолщины обводки', () => {
    const cylinder = new Cylinder({ diameter: 20, length: 10, style: { stroke: 4 } });
    const frame = new GLCollector().collect(sceneWith(cylinder), camera);
    const fills = frame.opaque.flatMap((b) => instances(b, 'fill'));
    const radii = fills.map(([x = 0, y = 0]) => Math.hypot(x, y));
    // Радиус крышки = радиусу бока: (20 + 4) / 2.
    expect(Math.max(...radii)).toBeCloseTo(12, 6);
    const body = frame.opaque.flatMap((b) => instances(b, 'cylinder'))[0];
    expect(body?.[6]).toBeCloseTo(12, 9);

    const box = new Box({ width: 10, height: 10, depth: 10, style: { stroke: 2 } });
    const boxFrame = new GLCollector().collect(sceneWith(box), camera);
    const corners = boxFrame.opaque.flatMap((b) => instances(b, 'fill'));
    expect(Math.max(...corners.map(([x = 0]) => x))).toBeCloseTo(6, 9);
    expect(boxFrame.opaque.reduce((n, b) => n + b.count('capsule'), 0)).toBe(0);
  });
});
