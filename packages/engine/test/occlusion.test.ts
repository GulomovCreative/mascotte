import { euler } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  Capsule,
  type Cutter,
  cutValue,
  DisplayList,
  Node,
  PathShape,
  Rect,
  Scene,
  ScreenOp,
  ScreenPath,
  Sphere,
  splitPath,
} from '../src/index.ts';

const plane = (depth: number): Cutter => ({
  kind: 'plane',
  x: 0,
  y: 0,
  depth,
  radius: 0,
  scale: 1,
});
const sphere = (radius: number): Cutter => ({
  kind: 'sphere',
  x: 0,
  y: 0,
  depth: 0,
  radius,
  scale: 1,
});

function points(path: ScreenPath): number[][] {
  const out: number[][] = [];
  let d = 0;
  let p = 0;
  for (let op = 0; op < path.opCount; op++) {
    const count = path.ops[op] === ScreenOp.cubic ? 3 : 1;
    for (let k = 0; k < count; k++) {
      out.push([path.data[d] ?? 0, path.data[d + 1] ?? 0, path.depths[p] ?? 0]);
      d += 2;
      p += 1;
    }
  }
  return out;
}

/** Points match the expected ones to `digits` digits (the seam is found by bisection). */
function expectPoints(actual: number[][], expected: number[][], digits = 9): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, i) => {
    point.forEach((value, k) => {
      expect(value, `point ${i}, coordinate ${k}`).toBeCloseTo(
        expected[i]?.[k] ?? Number.NaN,
        digits,
      );
    });
  });
}

function split(path: ScreenPath, cutter: Cutter) {
  const back = new ScreenPath();
  const front = new ScreenPath();
  splitPath(path, cutter, [back, front]);
  return { back, front };
}

describe('cutValue', () => {
  it('plane and the sphere front surface', () => {
    expect(cutValue(plane(5), 0, 0, 4)).toBeLessThan(0);
    expect(cutValue(plane(5), 0, 0, 6)).toBeGreaterThan(0);
    // Outside the silhouette the sphere covers nothing, even behind the center.
    expect(cutValue(sphere(10), 20, 0, -100)).toBeGreaterThan(0);
    // At the silhouette center the front surface is at radius depth.
    expect(cutValue(sphere(10), 0, 0, 9)).toBeLessThan(0);
    expect(cutValue(sphere(10), 0, 0, 11)).toBeGreaterThan(0);
    // Near the silhouette edge the surface is closer to the center plane: sqrt(100 − 64) = 6.
    expect(cutValue(sphere(10), 8, 0, 5.9)).toBeLessThan(0);
    expect(cutValue(sphere(10), 8, 0, 6.1)).toBeGreaterThan(0);
  });
});

describe('splitPath', () => {
  it('a line through a plane: the cut point is on the plane, the parts join', () => {
    const { back, front } = split(new ScreenPath().moveTo(0, 0, -10).lineTo(20, 10, 10), plane(0));
    expectPoints(points(back), [
      [0, 0, -10],
      [10, 5, 0],
    ]);
    expectPoints(points(front), [
      [10, 5, 0],
      [20, 10, 10],
    ]);
  });

  it('a curve through a plane: the seam is on the plane, the ends stay in place', () => {
    const path = new ScreenPath().moveTo(0, 0, -10).cubicTo(10, 20, 20, 20, 30, 0, -10, 10, 10);
    const { back, front } = split(path, plane(0));
    const b = points(back);
    const f = points(front);
    expect(b[0]).toEqual([0, 0, -10]);
    expect(f.at(-1)).toEqual([30, 0, 10]);
    expect(b.at(-1)?.[2]).toBeCloseTo(0, 9);
    expect(f[0]).toEqual(b.at(-1));
    // A symmetric curve crosses the plane in the middle.
    expect(b.at(-1)?.[0]).toBeCloseTo(15, 6);
    expect(back.ops[1]).toBe(ScreenOp.cubic);
    expect(front.ops[1]).toBe(ScreenOp.cubic);
  });

  it('the closing line of a closed path is cut too', () => {
    const path = new ScreenPath().moveTo(0, 0, -5).lineTo(10, 0, -5).lineTo(10, 10, 5).close();
    const { back, front } = split(path, plane(0));
    // Two pieces are behind the plane: the path start up to the middle of the second line, and the end of the closing one.
    expectPoints(points(back), [
      [0, 0, -5],
      [10, 0, -5],
      [10, 5, 0],
      [5, 5, 0],
      [0, 0, -5],
    ]);
    expectPoints(points(front), [
      [10, 5, 0],
      [10, 10, 5],
      [5, 5, 0],
    ]);
    expect(back.closed || front.closed).toBe(false);
  });

  it('without an intersection everything goes into one part', () => {
    const { back, front } = split(new ScreenPath().moveTo(0, 0, 1).lineTo(5, 5, 3), plane(0));
    expect(back.opCount).toBe(0);
    expect(points(front)).toEqual([
      [0, 0, 1],
      [5, 5, 3],
    ]);
  });

  it('sphere: a line passing through the ball is hidden inside the silhouette up to the front surface', () => {
    // From a point behind the ball on the left to a point in front of the ball on the right.
    const path = new ScreenPath().moveTo(-20, 0, -20).lineTo(20, 0, 20);
    const { back, front } = split(path, sphere(10));
    const f = points(front);
    // Outside the silhouette on the left the sphere covers nothing: the first front part runs to the silhouette edge.
    expectPoints(
      f.slice(0, 2),
      [
        [-20, 0, -20],
        [-10, 0, -10],
      ],
      6,
    );
    // The seam is on the front surface: z = sqrt(100 − x²) with x = z, so x = sqrt(50).
    const seam = f[2] ?? [];
    expect(seam[0]).toBeCloseTo(Math.sqrt(50), 6);
    expect(seam[2]).toBeCloseTo(Math.sqrt(50), 6);
    expect(front.ops.subarray(0, front.opCount).filter((op) => op === ScreenOp.move)).toHaveLength(
      2,
    );
    expect(back.opCount).toBe(2);
  });
});

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

function order(list: DisplayList): string[] {
  return Array.from({ length: list.count }, (_, i) => list.item(i).node?.id ?? '?');
}

function ear(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  return new PathShape({
    id: 'ear',
    path: [
      { type: 'move', point: from },
      { type: 'line', point: to },
    ],
    style: { stroke: 10 },
  });
}

describe('partial occlusion in the draw list', () => {
  const camera = new Camera();

  it('an ear sticking out of the head: the part behind the head is drawn before it, the rest after', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    head.add(ear({ x: 10, y: -10, z: -20 }, { x: 20, y: -60, z: 10 }));
    const list = new DisplayList().build(sceneWith(head), camera);
    expect(order(list)).toEqual(['ear', 'head', 'ear']);
    // The ear stays behind the front surface up to the silhouette edge. For cutting, the sphere
    // is inflated by half the ear width (5), so the seam is 45 from the center on screen.
    const [x = 0, y = 0] = points(list.item(2).path)[0] ?? [];
    expect(Math.hypot(x, y)).toBeCloseTo(45, 6);
  });

  it('a stroke fully behind the head but later in the tree moves before it', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    head.add(ear({ x: -10, y: 0, z: -30 }, { x: 10, y: 0, z: -30 }));
    const list = new DisplayList().build(sceneWith(head), camera);
    expect(order(list)).toEqual(['ear', 'head']);
  });

  it('no overlap on screen: no cut and no extra parts', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 20 } });
    const far = ear({ x: 100, y: 0, z: -30 }, { x: 120, y: 0, z: 30 });
    const list = new DisplayList().build(sceneWith(head, far), camera);
    expect(order(list)).toEqual(['head', 'ear']);
  });

  it('fill is not cut, the switch disables cutting', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    head.add(
      new Rect({
        id: 'filled',
        width: 20,
        height: 20,
        // In front of the head center but crossing it: with fill it is not cut and stays one element.
        position: { x: 0, y: 0, z: 10 },
        rotation: euler.create(0, 1.2, 0),
        style: { fill: true },
      }),
    );
    expect(order(new DisplayList().build(sceneWith(head), camera))).toEqual(['head', 'filled']);

    const other = new PathShape({ id: 'head', style: { stroke: 80 } });
    other.add(ear({ x: 10, y: -10, z: -20 }, { x: 20, y: -60, z: 10 }));
    // Without cutting the whole ear sorts by its center depth (behind the head) and is not split.
    expect(
      order(new DisplayList({ partialOcclusion: false }).build(sceneWith(other), camera)),
    ).toEqual(['ear', 'head']);
    expect(order(new DisplayList().build(sceneWith(other), camera))).toEqual([
      'ear',
      'head',
      'ear',
    ]);
  });

  it('a capsule is cut by a larger sphere; nothing attaches to a cut capsule', () => {
    const body = new Sphere({ id: 'body', diameter: 80 });
    const arm = new Capsule({
      id: 'arm',
      length: 60,
      diameter: 10,
      position: { x: 30, y: 0, z: 0 },
      rotation: euler.create(0, 1, 0),
    });
    const finger = ear({ x: 25, y: 0, z: -15 }, { x: 35, y: 0, z: 15 });
    const list = new DisplayList().build(sceneWith(body, arm, finger), camera);
    const ids = order(list);
    expect(ids.filter((id) => id === 'arm')).toHaveLength(2);
    expect(ids.indexOf('arm')).toBeLessThan(ids.indexOf('body'));
    expect(ids.lastIndexOf('arm')).toBeGreaterThan(ids.indexOf('body'));
    // The finger is cut by the body, not by the cut arm: it sits around the body.
    expect(ids.indexOf('ear')).toBeLessThan(ids.indexOf('body'));
  });

  it('parts are reused between frames', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    head.add(ear({ x: 10, y: -10, z: -20 }, { x: 20, y: -60, z: 10 }));
    const scene = sceneWith(head);
    const list = new DisplayList();
    list.build(scene, camera);
    const parts = [list.item(0), list.item(2)];
    head.rotation.copy({ x: 0, y: 0.01, z: 0, w: Math.sqrt(1 - 0.0001) });
    list.build(scene, camera);
    expect([list.item(0), list.item(2)]).toEqual(parts);
    expect(list.item(0)).toBe(parts[0]);
  });
});

describe('decals on a sphere', () => {
  const camera = new Camera();

  function face() {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    // The mouth lies inside the head sphere (z = 38 with radius 40), as in the Zdog mascot.
    const mouth = new PathShape({
      id: 'mouth',
      sortMode: 'attached',
      position: { x: 0, y: 12, z: 38 },
      path: [
        { type: 'move', point: { x: -6 } },
        { type: 'line', point: { x: 6 } },
      ],
      style: { stroke: 4 },
    });
    const eye = new Node({ sortMode: 'attached', position: { x: 14, y: -6, z: 36 } });
    eye.add(new PathShape({ id: 'white', style: { stroke: 10 } }));
    head.add(mouth).add(eye);
    return { head, scene: sceneWith(head) };
  }

  it('the anchor does not cut a decal, the decal is clipped to the anchor silhouette', () => {
    const { scene } = face();
    const list = new DisplayList().build(scene, camera);
    // Decals sort among themselves by depth: the mouth (z = 38) is closer than the eye (z = 36).
    expect(order(list)).toEqual(['head', 'white', 'mouth']);
    for (const id of ['mouth', 'white']) {
      const item = Array.from({ length: list.count }, (_, i) => list.item(i)).find(
        (x) => x.node?.id === id,
      );
      expect([item?.clip, item?.clipX, item?.clipY, item?.clipRadius], id).toEqual([
        'circle',
        0,
        0,
        40,
      ]);
    }
  });

  it('a regular child inside a sphere is covered by it, not clipped', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    head.add(
      new PathShape({
        id: 'inside',
        position: { x: 0, y: 12, z: 38 },
        path: [
          { type: 'move', point: { x: -6 } },
          { type: 'line', point: { x: 6 } },
        ],
        style: { stroke: 4 },
      }),
    );
    const list = new DisplayList().build(sceneWith(head), camera);
    expect(order(list)).toEqual(['inside', 'head']);
    expect(list.item(0).clip).toBe('none');
  });

  it('without partial occlusion decals are not clipped', () => {
    const { scene } = face();
    const list = new DisplayList({ partialOcclusion: false }).build(scene, camera);
    for (let i = 0; i < list.count; i++) expect(list.item(i).clip).toBe('none');
  });
});
