import { euler, quat, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import { Camera, createProjectedPoint, Node, Scene } from '../src/index.ts';
import { zdogFixture } from './zdog-fixture.ts';

const zdog = zdogFixture('camera');

function projected(camera: Camera, point: vec3.Vec3, referenceDepth?: number) {
  const out = createProjectedPoint();
  const visible = camera.project(out, point, referenceDepth);
  return { visible, ...out };
}

describe('Camera: orthographic', () => {
  it('defaults: no perspective, zoom 1, a point is unchanged', () => {
    const camera = new Camera();
    expect(camera.projection).toBe('orthographic');
    expect(projected(camera, { x: 3, y: -4, z: 50 })).toEqual({
      visible: true,
      x: 3,
      y: -4,
      depth: 50,
      scale: 1,
    });
  });

  it('zoom scales both coordinates and stroke scale', () => {
    const camera = new Camera({ zoom: 2 });
    expect(projected(camera, { x: 3, y: -4, z: -1000 })).toMatchObject({ x: 6, y: -8, scale: 2 });
    expect(camera.scaleAt(500)).toBe(2);
    expect(camera.isInFront(1e9)).toBe(true);
  });

  it('moving the camera shifts the frame the opposite way', () => {
    const camera = new Camera({ position: { x: 10, y: 5, z: 0 } });
    expect(projected(camera, { x: 10, y: 5, z: 0 })).toMatchObject({ x: 0, y: 0 });
    expect(projected(camera, { x: 0, y: 0, z: 0 })).toMatchObject({ x: -10, y: -5 });
  });

  it('rotating the camera 90° around Y shows the scene from the side', () => {
    const camera = new Camera({ rotation: euler.create(0, Math.PI / 2, 0) });
    // The camera looks along its own −z; after the rotation that is world −x.
    const side = projected(camera, { x: -10, y: 0, z: 0 });
    expect(side.x).toBeCloseTo(0, 12);
    expect(side.depth).toBeCloseTo(-10, 12);
    expect(side.y).toBeCloseTo(0, 12);
    const right = projected(camera, { x: 0, y: 3, z: -10 });
    expect(right.x).toBeCloseTo(10, 12);
    expect(right.y).toBeCloseTo(3, 12);
  });
});

describe('Camera: perspective', () => {
  const camera = new Camera({ projection: 'perspective', distance: 100, zoom: 2 });

  it('at depth 0 the scale equals zoom, closer is larger, farther is smaller', () => {
    expect(camera.scaleAt(0)).toBe(2);
    expect(camera.scaleAt(50)).toBe(4);
    expect(camera.scaleAt(-100)).toBe(1);
  });

  it('a point at the camera plane or behind it is not visible, out is unchanged', () => {
    const out = createProjectedPoint();
    out.x = 123;
    expect(camera.project(out, { x: 1, y: 1, z: 100 })).toBe(false);
    expect(camera.project(out, { x: 1, y: 1, z: 150 })).toBe(false);
    expect(out.x).toBe(123);
    expect(camera.isInFront(99.9)).toBe(true);
  });

  it('weak perspective: the reference depth scales every point of a shape equally', () => {
    const near = projected(camera, { x: 10, y: 0, z: 20 }, 0);
    const far = projected(camera, { x: 10, y: 0, z: -20 }, 0);
    expect(near.x).toBe(20);
    expect(far.x).toBe(20);
    expect(near.depth).toBe(20);
    expect(far.depth).toBe(-20);
    // Without a reference depth each point is scaled by its own depth.
    expect(projected(camera, { x: 10, y: 0, z: 20 }).x).toBeCloseTo(25, 12);
  });

  it('projectView takes a point in camera space', () => {
    const out = createProjectedPoint();
    expect(camera.projectView(out, { x: 1, y: 2, z: 50 })).toBe(true);
    expect(out).toEqual({ x: 4, y: 8, depth: 50, scale: 4 });
  });
});

describe('Camera: parameters and cache', () => {
  it('zoom and distance are validated, projectionVersion grows only on change', () => {
    const camera = new Camera();
    const version = camera.projectionVersion;
    camera.zoom = 1;
    camera.projection = 'orthographic';
    expect(camera.projectionVersion).toBe(version);
    camera.zoom = 3;
    camera.distance = 500;
    camera.projection = 'perspective';
    expect(camera.projectionVersion).toBe(version + 3);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        camera.zoom = bad;
      }).toThrow(RangeError);
      expect(() => new Camera({ distance: bad })).toThrow(RangeError);
    }
    expect(camera.zoom).toBe(3);
  });

  it('viewMatrix is cached and updated when the camera or its ancestor moves', () => {
    const rig = new Node();
    const camera = new Camera({ position: { x: 1, y: 0, z: 0 } });
    rig.add(camera);
    const view = camera.viewMatrix;
    expect(camera.viewMatrix).toBe(view);
    rig.position.x = 9;
    expect(camera.toView(vec3.create(), { x: 10, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(camera.viewMatrix).toBe(view);
    camera.setRotationFromEuler(euler.create(0, 0, Math.PI / 2));
    const turned = camera.toView(vec3.create(), { x: 10, y: 1, z: 0 });
    expect(turned.x).toBeCloseTo(1, 12);
    expect(turned.y).toBeCloseTo(0, 12);
    expect(camera.viewMatrix).toBe(view);
  });

  it('distance is validated in the setter too, zoom in the constructor', () => {
    const camera = new Camera({ distance: 200 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        camera.distance = bad;
      }).toThrow(RangeError);
      expect(() => new Camera({ zoom: bad })).toThrow(RangeError);
    }
    expect(camera.distance).toBe(200);
  });

  it('a degenerate camera is an error', () => {
    const camera = new Camera({ scale: { x: 0, y: 1, z: 1 } });
    expect(() => camera.viewMatrix).toThrow(/degenerate/);
  });

  it('a camera can live in the scene and be found by id', () => {
    const scene = new Scene();
    const camera = new Camera({ id: 'main-camera' });
    scene.root.add(camera);
    expect(scene.getById('main-camera')).toBe(camera);
  });
});

/*
 * Zdog has no camera: the illustration itself is rotated and scaled. A camera with the inverse
 * rotation and the same zoom must give the same picture.
 */
describe('Zdog compatibility', () => {
  it('a camera with the inverse rotation equals a rotated Zdog scene', () => {
    const rotate = { x: 0.4, y: -0.9, z: 0.3 };
    const zoom = 1.5;
    const points = [
      { x: 10, y: -5, z: 3 },
      { x: -7, y: 2, z: -12 },
      { x: 0, y: 20, z: 6 },
    ];
    const origins = zdog.next<{ x: number; y: number; z: number }[]>('origins', {
      rotate,
      points,
    });

    const sceneRotation = quat.fromEuler(
      quat.create(),
      euler.create(rotate.x, -rotate.y, rotate.z),
    );
    const camera = new Camera({ zoom });
    camera.rotation.copy(quat.conjugate(quat.create(), sceneRotation));

    points.forEach((point, i) => {
      const origin = origins[i];
      if (!origin) throw new Error('no Zdog point');
      const out = projected(camera, point);
      expect(out.x).toBeCloseTo(origin.x * zoom, 9);
      expect(out.y).toBeCloseTo(origin.y * zoom, 9);
      expect(out.depth).toBeCloseTo(origin.z, 9);
    });
  });
});

describe('Camera: perspective of a moved and rotated camera', () => {
  it('depth comes from camera space, not from world z', () => {
    const camera = new Camera({
      projection: 'perspective',
      distance: 100,
      position: { x: 0, y: 0, z: 50 },
    });
    // In camera space the point is at depth −50: scale 100 / 150.
    const out = projected(camera, { x: 10, y: 0, z: 0 });
    expect(out.depth).toBeCloseTo(-50, 12);
    expect(out.scale).toBeCloseTo(2 / 3, 12);
    expect(out.x).toBeCloseTo(20 / 3, 12);
  });

  it('a camera turned 180° sees world +z as −z', () => {
    const camera = new Camera({
      projection: 'perspective',
      distance: 100,
      rotation: euler.create(0, Math.PI, 0),
    });
    const out = projected(camera, { x: 0, y: 0, z: 50 });
    expect(out.depth).toBeCloseTo(-50, 12);
    expect(out.scale).toBeCloseTo(2 / 3, 12);
  });

  it('getEyePosition: the eye is distance behind the node, orthographic has none', () => {
    const camera = new Camera({
      projection: 'perspective',
      distance: 100,
      position: { x: 5, y: 0, z: 0 },
      rotation: euler.create(0, Math.PI / 2, 0),
      scale: 3,
    });
    const eye = camera.getEyePosition(vec3.create());
    if (!eye) throw new Error('a perspective camera has an eye');
    // After a 90° rotation around Y the local z axis is world +x; scale is ignored.
    expect(eye.x).toBeCloseTo(105, 9);
    expect(eye.y).toBeCloseTo(0, 9);
    expect(eye.z).toBeCloseTo(0, 9);
    // A point at the eye is on the visibility boundary.
    expect(camera.isInFront(camera.toView(vec3.create(), eye).z)).toBe(false);
    camera.projection = 'orthographic';
    expect(camera.getEyePosition(vec3.create())).toBeNull();
  });

  it('referenceDepth decides visibility even if the point itself is behind the eye', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100, zoom: 2 });
    const out = createProjectedPoint();
    expect(camera.project(out, { x: 1, y: 0, z: 150 }, 0)).toBe(true);
    expect(out).toEqual({ x: 2, y: 0, depth: 150, scale: 2 });
    const untouched = createProjectedPoint();
    expect(camera.project(untouched, { x: 1, y: 0, z: 0 }, 150)).toBe(false);
    expect(untouched).toEqual(createProjectedPoint());
  });

  it('a very distant point is visible and nearly zero size', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100 });
    const scale = camera.scaleAt(-1e9);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1e-6);
    expect(camera.isInFront(-1e9)).toBe(true);
  });

  it('switching back to orthographic disables perspective', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100, zoom: 2 });
    camera.projection = 'orthographic';
    expect(camera.scaleAt(50)).toBe(2);
    expect(camera.isInFront(1e9)).toBe(true);
  });

  it('in orthographic referenceDepth does not affect scale, depth comes from the point', () => {
    const camera = new Camera({ zoom: 3 });
    expect(projected(camera, { x: 3, y: 0, z: 7 }, -500)).toMatchObject({
      x: 9,
      depth: 7,
      scale: 3,
    });
  });
});

describe('Camera: node scale does not reach the frame', () => {
  it('camera and ancestor scale do not change the picture', () => {
    const rotation = euler.create(0.3, 0.2, 0.1);
    const plain = new Camera({ position: { x: 1, y: 2, z: 3 }, rotation });
    // Uniform ancestor scale does not change orientation; position (0.5, 1, 1.5) · 2 = (1, 2, 3).
    const rig = new Node({ scale: 2 });
    const scaled = new Camera({ position: { x: 0.5, y: 1, z: 1.5 }, rotation, scale: 5 });
    rig.add(scaled);
    const point = { x: 7, y: -3, z: 2 };
    const a = plain.toView(vec3.create(), point);
    const b = scaled.toView(vec3.create(), point);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
    expect(b.z).toBeCloseTo(a.z, 9);
  });

  it('with non-uniform ancestor scale a circle stays a circle', () => {
    const rig = new Node({ scale: { x: 1, y: 4, z: 1 }, rotation: euler.create(0, 0, 0.7) });
    const camera = new Camera();
    rig.add(camera);
    // Points on a circle of radius 10 around the camera stay at distance 10.
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const world = camera.localToWorld(vec3.create(), { x: 0, y: 0, z: 0 });
      const point = {
        x: world.x + 10 * Math.cos(angle),
        y: world.y + 10 * Math.sin(angle),
        z: world.z,
      };
      const view = camera.toView(vec3.create(), point);
      expect(Math.hypot(view.x, view.y, view.z)).toBeCloseTo(10, 9);
    }
  });
});
