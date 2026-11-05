import { euler } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  Capsule,
  Cone,
  ConeSurface,
  Cylinder,
  Ellipse,
  Hemisphere,
  HemisphereDome,
  HitTester,
  MAX_ANCHORS,
  type Node,
  PathShape,
  Rect,
  Scene,
  Sphere,
} from '../src/index.ts';

const camera = new Camera();
const viewport = { width: 100, height: 100 } as const;

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

/** Hit at point (x, y) relative to the center of a 100×100 frame. */
function hit(scene: Scene, x: number, y: number, cam = camera) {
  return new HitTester().hitTest(scene, cam, viewport, 50 + x, 50 + y);
}

describe('HitTester', () => {
  it('an empty point and an empty scene give null', () => {
    expect(hit(new Scene(), 0, 0)).toBeNull();
    expect(hit(sceneWith(new Sphere({ diameter: 10 })), 30, 30)).toBeNull();
  });

  it('the nearest shape is visible, depth is the front surface point', () => {
    const far = new Sphere({ id: 'far', diameter: 40, style: { stroke: 0 } });
    const near = new Sphere({
      id: 'near',
      diameter: 10,
      position: { x: 0, y: 0, z: 30 },
      style: { stroke: 0 },
    });
    const scene = sceneWith(near, far);
    const front = hit(scene, 0, 0);
    expect(front?.drawable).toBe(near);
    expect(front?.depth).toBeCloseTo(35, 9);
    expect(hit(scene, 12, 0)?.drawable).toBe(far);
    expect(hit(scene, 12, 0)?.depth).toBeCloseTo(Math.sqrt(400 - 144), 9);
  });

  it('intersecting spheres: each is visible on its own half', () => {
    const left = new Sphere({ diameter: 40, position: { x: -6, y: 0, z: 0 } });
    const right = new Sphere({ diameter: 40, position: { x: 6, y: 0, z: 0 } });
    const scene = sceneWith(left, right);
    expect(hit(scene, -2, 0)?.drawable).toBe(left);
    expect(hit(scene, 2, 0)?.drawable).toBe(right);
  });

  it('at equal depth the one drawn earlier is visible', () => {
    const first = new PathShape({ style: { stroke: 10 } });
    const second = new PathShape({ style: { stroke: 10 } });
    expect(hit(sceneWith(first, second), 0, 0)?.drawable).toBe(first);
  });

  it('layer −1 is below the content even if closer; layer +1 is above it even if farther', () => {
    const body = new Sphere({ diameter: 40 });
    const under = new PathShape({
      sortMode: 'layer',
      layer: -1,
      position: { x: -10, y: 0, z: 50 },
      style: { stroke: 8 },
    });
    const over = new PathShape({
      sortMode: 'layer',
      layer: 1,
      position: { x: 10, y: 0, z: -50 },
      style: { stroke: 8 },
    });
    const scene = sceneWith(body, under, over);
    expect(hit(scene, -10, 0)?.drawable).toBe(body);
    expect(hit(scene, 10, 0)?.drawable).toBe(over);
    // Outside the body the lower layer is visible.
    under.position.x = -30;
    expect(hit(scene, -30, 0)?.drawable).toBe(under);
  });

  it('a decal is visible only on its anchor, even when deeper than its surface; the last one is visible', () => {
    const head = new Sphere({ diameter: 40, style: { stroke: 0 } });
    const spot = new PathShape({
      sortMode: 'attached',
      position: { x: 20, y: 0, z: -2 },
      style: { stroke: 10 },
    });
    const pupil = new PathShape({
      sortMode: 'attached',
      // Closer than the spot: decals are drawn by depth, so the pupil is on top.
      position: { x: 20, y: 0, z: -1 },
      style: { stroke: 4 },
    });
    head.add(spot);
    head.add(pupil);
    const scene = sceneWith(head);
    expect(hit(scene, 17, 0)?.drawable).toBe(spot);
    expect(hit(scene, 19, 0)?.drawable).toBe(pupil);
    // Outside the head silhouette there is no decal.
    expect(hit(scene, 23, 0)).toBeNull();
  });

  it('a decal is covered by whatever covers its anchor', () => {
    const head = new Sphere({ diameter: 40, style: { stroke: 0 } });
    head.add(
      new PathShape({
        sortMode: 'attached',
        position: { x: 0, y: 0, z: 19 },
        style: { stroke: 8 },
      }),
    );
    const hand = new Sphere({ diameter: 10, position: { x: 0, y: 0, z: 40 } });
    expect(hit(sceneWith(head, hand), 0, 0)?.drawable).toBe(hand);
  });

  it('with a translucent anchor a decal is a regular shape and is compared by depth', () => {
    const head = new Sphere({ diameter: 40, opacity: 0.5, style: { stroke: 0 } });
    const inside = new PathShape({
      sortMode: 'attached',
      position: { x: 0, y: 0, z: 10 },
      style: { stroke: 4 },
    });
    head.add(inside);
    expect(hit(sceneWith(head), 0, 0)?.drawable).toBe(head);
  });

  it('a solid part: the node is the solid itself', () => {
    const cylinder = new Cylinder({ diameter: 20, length: 20 });
    const result = hit(sceneWith(cylinder), 0, 0);
    expect(result?.node).toBe(cylinder);
    expect(result?.drawable.owner).toBe(cylinder);
    // Axis along z: the front cap at z = 10 is visible.
    expect(result?.depth).toBeCloseTo(10, 6);
    // A cylinder turned across the view: the side wall is visible.
    cylinder.setRotationFromEuler(euler.create(0, Math.PI / 2, 0));
    const side = hit(sceneWith(cylinder), 0, 0);
    expect(side?.drawable.owner).toBe(cylinder);
    expect(side?.depth).toBeCloseTo(10.5, 6);
  });

  it('cone and hemisphere: depth of the cone side and the dome', () => {
    // Apex at z = 20, base radius 10: at distance 1 from the axis the side is at z = 18.
    expect(
      hit(sceneWith(new Cone({ diameter: 20, length: 20, style: { stroke: 0 } })), 1, 0)?.depth,
    ).toBeCloseTo(18, 6);
    expect(hit(sceneWith(new Hemisphere({ diameter: 20 })), 0, 0)?.depth).toBeCloseTo(10.5, 6);
  });

  it('hidden, invisible and back side without backfaceVisible are not hit', () => {
    const hidden = new Sphere({ diameter: 20, visible: false });
    const clear = new Sphere({ diameter: 20, opacity: 0 });
    const back = new Rect({
      width: 20,
      height: 20,
      rotation: euler.create(0, Math.PI, 0),
      style: { fill: true, backfaceVisible: false },
    });
    expect(hit(sceneWith(hidden, clear, back), 0, 0)).toBeNull();
  });

  it('fill, stroke and curves', () => {
    const scene = sceneWith(
      new Rect({ width: 20, height: 20, style: { fill: true, stroke: 2 } }),
      new Ellipse({ diameter: 60, position: { x: 0, y: 0, z: -10 }, style: { stroke: 4 } }),
    );
    expect(hit(scene, 0, 0)?.drawable).toBeInstanceOf(Rect);
    // The stroke extends past the fill edge by half its width.
    expect(hit(scene, 10.8, 0)?.drawable).toBeInstanceOf(Rect);
    // A ring without fill: hits only on the stroke.
    expect(hit(scene, 30, 0)?.drawable).toBeInstanceOf(Ellipse);
    expect(hit(scene, 0, -30)?.drawable).toBeInstanceOf(Ellipse);
    expect(hit(scene, 20, 0)).toBeNull();
  });

  it('perspective and camera scale are applied', () => {
    const sphere = new Sphere({ diameter: 10, position: { x: 20, y: 0, z: 0 } });
    expect(hit(sceneWith(sphere), 40, 0, new Camera({ zoom: 2 }))?.drawable).toBe(sphere);
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    sphere.position.z = 50;
    // At depth 50 with distance 100 the scale is 2: the sphere center on screen is at x = 40.
    expect(hit(sceneWith(sphere), 40, 0, perspective)?.drawable).toBe(sphere);
    expect(hit(sceneWith(sphere), 20, 0, perspective)).toBeNull();
  });

  it('a decal on a solid is visible on any of its parts', () => {
    const cylinder = new Cylinder({ diameter: 20, length: 20 });
    const label = new PathShape({
      sortMode: 'attached',
      position: { x: 0, y: 0, z: 9 },
      style: { stroke: 6 },
    });
    cylinder.add(label);
    const scene = sceneWith(cylinder);
    // The front cap at z = 10 is closer than the decal, but a decal on its anchor is still visible.
    expect(hit(scene, 0, 0)?.drawable).toBe(label);
    expect(hit(scene, 0, 0)?.node).toBe(label);
    expect(hit(scene, 8, 0)?.node).toBe(cylinder);
    expect(hit(scene, 20, 0)).toBeNull();
  });

  it(`beyond ${MAX_ANCHORS} anchors in a layer decals are regular shapes, as in the frame`, () => {
    const heads: Node[] = [];
    const decals: Node[] = [];
    for (let i = 0; i <= MAX_ANCHORS; i++) {
      const head = new Sphere({
        diameter: 4,
        position: { x: i * 10, y: 0, z: 0 },
        style: { stroke: 0 },
      });
      // A decal inside the head: visible only while it is a decal.
      const decal = new PathShape({ sortMode: 'attached', position: { x: 0, y: 0, z: -1 } });
      head.add(decal);
      heads.push(head);
      decals.push(decal);
    }
    const scene = sceneWith(...heads);
    const tester = new HitTester();
    const at = (i: number) => tester.hitTest(scene, camera, viewport, 50 + i * 10, 50)?.drawable;
    expect(at(0)).toBe(decals[0]);
    expect(at(MAX_ANCHORS - 1)).toBe(decals[MAX_ANCHORS - 1]);
    expect(at(MAX_ANCHORS)).toBe(heads[MAX_ANCHORS]);
  });

  it('a dome facing away from the viewer is seen from inside, by its far side', () => {
    const dome = new HemisphereDome({ style: { stroke: 0 } });
    dome.diameter = 20;
    dome.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(hit(sceneWith(dome), 0, 0)?.depth).toBeCloseTo(-10, 6);
    expect(hit(sceneWith(dome), 6, 0)?.depth).toBeCloseTo(-8, 6);
  });

  it('a cone with its base toward the viewer is seen from inside', () => {
    const cone = new ConeSurface({ style: { stroke: 0 } });
    cone.diameter = 20;
    cone.length = 20;
    cone.setRotationFromEuler(euler.create(0, Math.PI, 0));
    // Apex at z = −20, radius 10 at the base: at distance 1 from the axis the wall is at z = −18.
    expect(hit(sceneWith(cone), 1, 0)?.depth).toBeCloseTo(-18, 6);
    expect(hit(sceneWith(cone), 11, 0)).toBeNull();
  });

  it('fill depth is interpolated across a tilted plane', () => {
    const rect = new Rect({ width: 20, height: 20, style: { fill: true, stroke: 0 } });
    rect.setRotationFromEuler(euler.create(0, 0.5, 0));
    const scene = sceneWith(rect);
    const depth = (x: number) => hit(scene, x, 0)?.depth ?? Number.NaN;
    // Plane through the center: depth is proportional to x with slope tan 0.5.
    expect(Math.abs(depth(4))).toBeCloseTo(4 * Math.tan(0.5), 6);
    expect(depth(-4)).toBeCloseTo(-depth(4), 6);
    expect(depth(2) * 2).toBeCloseTo(depth(4), 6);
  });

  it('a capsule end is a hemisphere at the axis end', () => {
    const capsule = new Capsule({ length: 20, diameter: 6, style: { stroke: 0 } });
    capsule.setRotationFromEuler(euler.create(0, Math.PI / 2, 0));
    const scene = sceneWith(capsule);
    // Ends at x = ±10, radius 3: 1 past the end the depth is √(9 − 1).
    expect(hit(scene, 11, 0)?.depth).toBeCloseTo(Math.sqrt(8), 6);
    expect(hit(scene, 0, 0)?.depth).toBeCloseTo(3, 6);
    expect(hit(scene, 13.5, 0)).toBeNull();
  });
});
