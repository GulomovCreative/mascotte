import { euler, TAU, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  BOX_FACES,
  Box,
  Camera,
  Capsule,
  Cone,
  Cylinder,
  createProjectedPoint,
  Hemisphere,
  Node,
  Scene,
  ScreenOp,
  type Shape,
  Sphere,
  type Surface,
  SurfaceOutline,
} from '../src/index.ts';
import { zdogFixture } from './zdog-fixture.ts';

const zdog = zdogFixture('solids');

/** Rotations that show different sides of the shapes. */
const ROTATIONS = [
  { x: 0.3, y: -0.6, z: 0.2 },
  { x: -1.1, y: 0.4, z: 0 },
  { x: 0.5, y: 2.6, z: -0.8 },
  { x: 1.4, y: 0.1, z: 0.3 },
];

interface Recorded {
  ops: number[];
  values: number[];
  lineWidth: number | null;
  lineCap: string | null;
}

function fromOutline(out: SurfaceOutline): Recorded {
  const path = out.path;
  return {
    ops: Array.from(path.ops.subarray(0, path.opCount)),
    values: Array.from(path.data.subarray(0, path.dataCount)),
    lineWidth: out.hasStroke ? out.lineWidth : null,
    lineCap: out.lineCap,
  };
}

function expectSame(actual: Recorded, expected: Recorded, label: string): void {
  expect(actual.ops, label).toEqual(expected.ops);
  expect(actual.lineCap, label).toBe(expected.lineCap);
  if (expected.lineWidth === null) expect(actual.lineWidth, label).toBeNull();
  else expect(actual.lineWidth, label).toBeCloseTo(expected.lineWidth, 9);
  expect(actual.values.length, label).toBe(expected.values.length);
  actual.values.forEach((value, i) => {
    expect(value, `${label}: number ${i}`).toBeCloseTo(expected.values[i] ?? Number.NaN, 9);
  });
}

/** Root node with a Zdog rotation {x, y, z} in our system ({x, -y, z}). */
function rootFor(rotate: { x: number; y: number; z: number }): Node {
  return new Node({ rotation: euler.create(rotate.x, -rotate.y, rotate.z) });
}

function outlineOf(surface: Surface, camera = new Camera()): Recorded | null {
  const out = new SurfaceOutline();
  return surface.buildOutline(camera, out) ? fromOutline(out) : null;
}

/** A surface that must be built. */
function mustOutline(surface: Surface, camera = new Camera()): Recorded {
  const recorded = outlineOf(surface, camera);
  if (!recorded) throw new Error(`surface ${surface.id} must be built`);
  return recorded;
}

function scaled(recorded: Recorded, factor: number): Recorded {
  return {
    ...recorded,
    values: recorded.values.map((v, i) =>
      // Arc angles (4th and 5th numbers) and direction are not scaled.
      recorded.ops[0] === ScreenOp.arc && i % 6 >= 3 ? v : v * factor,
    ),
    lineWidth: recorded.lineWidth === null ? null : recorded.lineWidth * factor,
  };
}

/** Our scene with the same root, translation and scale as the Zdog scene in the fixture. */
interface Setup {
  rotate: { x: number; y: number; z: number };
  scale?: number;
  translate?: { x: number; y: number; z: number };
  zoom?: number;
  nested?: boolean;
}

function ourParent(setup: Setup): Node {
  const root = rootFor(setup.rotate);
  const holder = new Node({
    scale: setup.scale ?? 1,
    position: setup.translate ?? { x: 0, y: 0, z: 0 },
  });
  root.add(holder);
  if (!setup.nested) return holder;
  const inner = new Node({ rotation: euler.create(0, 0, 0.4) });
  holder.add(inner);
  return inner;
}

const SETUPS: Setup[] = [
  ...ROTATIONS.map((rotate) => ({ rotate })),
  { rotate: ROTATIONS[0] ?? { x: 0, y: 0, z: 0 }, zoom: 2 },
  { rotate: ROTATIONS[1] ?? { x: 0, y: 0, z: 0 }, scale: 1.5, translate: { x: 7, y: -4, z: 3 } },
  { rotate: ROTATIONS[2] ?? { x: 0, y: 0, z: 0 }, scale: 0.6, nested: true, zoom: 1.5 },
];

/*
 * With node scale ≠ 1 our stroke scales and Zdog stroke does not. So with scale
 * the comparison runs without stroke, and stroke scaling is checked separately.
 */
function strokeFor(setup: Setup, stroke: number): number {
  return (setup.scale ?? 1) === 1 ? stroke : 0;
}

describe('screen parts match Zdog', () => {
  it('hemisphere dome', () => {
    for (const setup of SETUPS) {
      const stroke = strokeFor(setup, 3);
      const recorded = zdog.next<Recorded>('dome', { setup, stroke });

      const ours = new Hemisphere({
        diameter: 40,
        style: { stroke },
        position: { x: 5, y: -2, z: 0 },
      });
      ourParent(setup).add(ours);
      const zoom = setup.zoom ?? 1;
      const actual = mustOutline(ours.dome, new Camera({ zoom }));
      expectSame(actual, scaled(recorded, zoom), JSON.stringify(setup));
    }
  });

  it('cylinder side surface', () => {
    for (const setup of SETUPS) {
      const stroke = strokeFor(setup, 2);
      const recorded = zdog.next<Recorded>('cylinder', { setup, stroke });

      const ours = new Cylinder({ diameter: 30, length: 50, style: { stroke } });
      ourParent(setup).add(ours);
      const zoom = setup.zoom ?? 1;
      const actual = mustOutline(ours.body, new Camera({ zoom }));
      expectSame(actual, scaled(recorded, zoom), JSON.stringify(setup));
    }
  });

  it('cone surface, including a view angle where it is not visible', () => {
    let hidden = 0;
    const setups: Setup[] = [
      ...SETUPS,
      { rotate: { x: 0, y: 0, z: 0 } },
      { rotate: { x: Math.PI, y: 0, z: 0 } },
    ];
    for (const setup of setups) {
      const stroke = strokeFor(setup, 2);
      const recorded = zdog.next<Recorded>('cone', { setup, stroke });

      const ours = new Cone({ diameter: 30, length: 40, style: { stroke } });
      ourParent(setup).add(ours);
      const zoom = setup.zoom ?? 1;
      const actual = outlineOf(ours.surface, new Camera({ zoom }));
      if (recorded.ops.length === 0) {
        hidden++;
        expect(actual, JSON.stringify(setup)).toBeNull();
      } else {
        if (!actual) throw new Error('the cone surface must be drawn');
        expectSame(actual, scaled(recorded, zoom), JSON.stringify(setup));
      }
    }
    expect(hidden).toBeGreaterThan(0);
  });

  it('bases and faces are regular shapes at the same world points as in Zdog', () => {
    for (const setup of SETUPS) {
      const expected = zdog.next<{ faces: WorldPath[]; bases: WorldPath[] }>('faces', { setup });

      const box = new Box({ width: 20, height: 30, depth: 40 });
      const cylinder = new Cylinder({ diameter: 16, length: 24 });
      ourParent(setup).add(box).add(cylinder);

      expect(expected.faces).toHaveLength(6);
      BOX_FACES.forEach((face, i) => {
        expectWorldPath(box.faces[face], expected.faces[i] as WorldPath);
      });
      expectWorldPath(cylinder.frontBase, expected.bases[0] as WorldPath);
      expectWorldPath(cylinder.rearBase, expected.bases[1] as WorldPath);
    }
  });
});

/** World end points of path commands and the world normal of a Zdog shape. */
interface WorldPath {
  ends: { x: number; y: number; z: number }[];
  normal: { x: number; y: number; z: number };
}

/** World end points of our shape path commands against the Zdog points from the fixture. */
function expectWorldPath(shape: Shape, zdog: WorldPath): void {
  const geometry = shape.geometry;
  const point = vec3.create();
  const ourEnds: number[] = [];
  let index = 0;
  for (let op = 0; op < geometry.opCount; op++) {
    // Arcs and curves have three points, the end is the last one.
    index += geometry.ops[op] === 2 ? 3 : 1;
    const i = (index - 1) * 3;
    shape.localToWorld(point, {
      x: geometry.points[i] ?? 0,
      y: geometry.points[i + 1] ?? 0,
      z: geometry.points[i + 2] ?? 0,
    });
    ourEnds.push(point.x, point.y, point.z);
  }
  const zdogEnds = zdog.ends;
  expect(ourEnds.length).toBe(zdogEnds.length * 3);
  zdogEnds.forEach((end, i) => {
    expect(ourEnds[i * 3]).toBeCloseTo(end?.x ?? Number.NaN, 9);
    expect(ourEnds[i * 3 + 1]).toBeCloseTo(end?.y ?? Number.NaN, 9);
    expect(ourEnds[i * 3 + 2]).toBeCloseTo(end?.z ?? Number.NaN, 9);
  });
  // The front faces the same way: the world normal matches Zdog.
  const origin = shape.localToWorld(vec3.create(), { x: 0, y: 0, z: 0 });
  const front = shape.localToWorld(vec3.create(), { x: 0, y: 0, z: 1 });
  expect(origin.x - front.x).toBeCloseTo(zdog.normal.x, 9);
  expect(origin.y - front.y).toBeCloseTo(zdog.normal.y, 9);
  expect(origin.z - front.z).toBeCloseTo(zdog.normal.z, 9);
}

describe('solid perspective', () => {
  const camera = new Camera({ projection: 'perspective', distance: 100 });

  it('the cylinder side meets the base centers projected at the cylinder depth', () => {
    const cylinder = new Cylinder({
      diameter: 20,
      length: 50,
      rotation: euler.create(0, 0.6, 0),
      position: { x: 0, y: 0, z: 10 },
    });
    const body = mustOutline(cylinder.body, camera);
    const depth = camera.toView(vec3.create(), cylinder.getWorldPosition(vec3.create())).z;
    const ends = [cylinder.frontBase, cylinder.rearBase].map((base) => {
      const out = createProjectedPoint();
      expect(camera.project(out, base.getWorldPosition(vec3.create()), depth)).toBe(true);
      return [out.x, out.y];
    });
    expect(body.values[0]).toBeCloseTo(ends[0]?.[0] ?? Number.NaN, 9);
    expect(body.values[1]).toBeCloseTo(ends[0]?.[1] ?? Number.NaN, 9);
    expect(body.values[2]).toBeCloseTo(ends[1]?.[0] ?? Number.NaN, 9);
    expect(body.values[3]).toBeCloseTo(ends[1]?.[1] ?? Number.NaN, 9);
    // Width uses the cylinder depth scale, not the ends.
    expect(body.lineWidth).toBeCloseTo((20 + 1) * camera.scaleAt(depth), 9);
  });

  it('all solid parts use the owner depth', () => {
    const cone = new Cone();
    const box = new Box();
    for (const part of [cone.surface, cone.base, ...BOX_FACES.map((f) => box.faces[f])]) {
      expect(part.perspectiveReference).toBe(part.owner);
    }
    const sphere = new Sphere();
    expect(sphere.perspectiveReference).toBe(sphere);
  });

  it('dome and cone in perspective: coordinates and width are multiplied by the depth scale', () => {
    const ortho = new Camera();
    for (const make of [
      () => new Hemisphere({ diameter: 10, rotation: euler.create(0.4, 0.2, 0) }),
      () => new Cone({ diameter: 10, length: 20, rotation: euler.create(0.4, 0.2, 0) }),
    ]) {
      const flat = make();
      const near = make();
      near.position.z = 50;
      const flatSurface = flat instanceof Hemisphere ? flat.dome : (flat as Cone).surface;
      const nearSurface = near instanceof Hemisphere ? near.dome : (near as Cone).surface;
      const base = mustOutline(flatSurface, ortho);
      const actual = mustOutline(nearSurface, camera);
      // A z offset does not change x and y in camera space; the scale at depth 50 is 2.
      expectSame(actual, scaled(base, 2), flat.constructor.name);
    }
  });
});

describe('sphere and capsule', () => {
  it('a sphere is a circle; radius and stroke scale with the node', () => {
    const sphere = new Sphere({
      diameter: 10,
      position: { x: 4, y: -3, z: 0 },
      scale: 2,
      style: { stroke: 1 },
    });
    const recorded = mustOutline(sphere, new Camera({ zoom: 3 }));
    expect(recorded.ops).toEqual([ScreenOp.arc]);
    expect(recorded.values).toEqual([12, -9, 30, 0, TAU, 0]);
    expect(recorded.lineWidth).toBe(6);
  });

  it('a sphere with non-uniform scale uses the x scale', () => {
    const recorded = mustOutline(new Sphere({ diameter: 10, scale: { x: 2, y: 5, z: 7 } }));
    expect(recorded.values[2]).toBe(10);
  });

  it('a capsule is a thick line along z, a degenerate one is a circle', () => {
    const capsule = new Capsule({
      length: 20,
      diameter: 6,
      rotation: euler.create(Math.PI / 2, 0, 0),
      scale: { x: 2, y: 1, z: 1 },
    });
    const recorded = mustOutline(capsule);
    expect(recorded.ops).toEqual([ScreenOp.move, ScreenOp.line]);
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = recorded.values;
    expect(Math.hypot(x2 - x1, y2 - y1)).toBeCloseTo(20, 9);
    // Width uses the x scale: (6 + 1) · 2.
    expect(recorded.lineWidth).toBeCloseTo(14, 12);
    const end = mustOutline(new Capsule({ length: 20, diameter: 6 }));
    expect(end.ops).toEqual([ScreenOp.arc]);
    expect(end.lineWidth).toBeNull();
    expect(end.values[2]).toBeCloseTo(3.5, 12);
  });

  it('a surface behind the perspective camera eye is not drawn', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100 });
    for (const surface of [
      new Sphere({ position: { x: 0, y: 0, z: 150 } }),
      new Capsule({ position: { x: 0, y: 0, z: 150 } }),
    ]) {
      expect(outlineOf(surface, camera)).toBeNull();
    }
  });

  it('perspective enlarges a nearer sphere', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100 });
    const near = mustOutline(new Sphere({ diameter: 10, position: { x: 0, y: 0, z: 50 } }), camera);
    const far = mustOutline(
      new Sphere({ diameter: 10, position: { x: 0, y: 0, z: -100 } }),
      camera,
    );
    expect(near.values[2]).toBeCloseTo(10, 12);
    expect(far.values[2]).toBeCloseTo(2.5, 12);
  });
});

describe('surface brush', () => {
  it('fill, stroke, color and line caps of every surface', () => {
    const cases: [Surface, { hasFill: boolean; hasStroke: boolean; lineCap: string }][] = [
      [new Sphere(), { hasFill: true, hasStroke: true, lineCap: 'round' }],
      [
        new Hemisphere({ rotation: euler.create(0.3, 0, 0) }).dome,
        { hasFill: true, hasStroke: true, lineCap: 'round' },
      ],
      [
        new Cone({ rotation: euler.create(1.2, 0, 0) }).surface,
        { hasFill: true, hasStroke: true, lineCap: 'round' },
      ],
      [new Cylinder().body, { hasFill: false, hasStroke: true, lineCap: 'butt' }],
      [
        new Capsule({ rotation: euler.create(1, 0, 0) }),
        { hasFill: false, hasStroke: true, lineCap: 'round' },
      ],
    ];
    for (const [surface, expected] of cases) {
      const out = new SurfaceOutline();
      expect(surface.buildOutline(new Camera(), out), surface.id).toBe(true);
      expect(
        { hasFill: out.hasFill, hasStroke: out.hasStroke, lineCap: out.lineCap },
        surface.id,
      ).toEqual(expected);
      expect(out.color).toBe('#333');
    }
    const sphere = new Sphere({ style: { fill: false, stroke: 0, color: '#f00' } });
    const out = new SurfaceOutline();
    sphere.buildOutline(new Camera(), out);
    expect([out.hasFill, out.hasStroke, out.color]).toEqual([false, false, '#f00']);
  });
});

describe('degenerate cone', () => {
  it('zero sizes and scale do not produce NaN', () => {
    const cases = [
      new Cone({ diameter: 0, length: 10, rotation: euler.create(1.2, 0, 0) }),
      new Cone({ diameter: 10, length: 0, rotation: euler.create(1.2, 0, 0) }),
      new Cone({ diameter: 10, length: 10, scale: 0 }),
      new Cone({ diameter: 10, length: 10, rotation: euler.create(Math.PI / 2, 0, 0) }),
    ];
    for (const cone of cases) {
      const out = new SurfaceOutline();
      if (cone.surface.buildOutline(new Camera(), out)) {
        const values = Array.from(out.path.data.subarray(0, out.path.dataCount));
        expect(values.every(Number.isFinite)).toBe(true);
        expect(Number.isFinite(out.lineWidth)).toBe(true);
      }
    }
  });
});

describe('solids pass style and parameters to children', () => {
  it('every style field reaches every part', () => {
    const solids = [new Hemisphere(), new Cone(), new Cylinder(), new Box()];
    for (const solid of solids) {
      solid.style.stroke = 4;
      solid.style.fill = false;
      solid.style.color = '#0f0';
      solid.style.backfaceColor = '#111';
      for (const child of solid.children as (Shape | Surface)[]) {
        const label = child.id;
        expect(child.style.stroke, label).toBe(4);
        expect(child.style.fill, label).toBe(false);
        expect(child.style.color, label).toBe('#0f0');
      }
    }
    const hemisphere = solids[0] as Hemisphere;
    hemisphere.style.backfaceVisible = false;
    expect(hemisphere.base.style.backfaceVisible).toBe(false);
    expect(hemisphere.base.style.backfaceColor).toBe('#111');
  });

  it('parameters reach every part', () => {
    const hemisphere = new Hemisphere();
    hemisphere.diameter = 12;
    expect([hemisphere.base.diameter, hemisphere.dome.diameter]).toEqual([12, 12]);

    const cylinder = new Cylinder();
    cylinder.diameter = 7;
    cylinder.length = 30;
    expect([
      cylinder.frontBase.diameter,
      cylinder.rearBase.diameter,
      cylinder.body.diameter,
    ]).toEqual([7, 7, 7]);
    expect([
      cylinder.frontBase.position.z,
      cylinder.rearBase.position.z,
      cylinder.body.length,
    ]).toEqual([15, -15, 30]);

    const cone = new Cone();
    cone.diameter = 5;
    cone.length = 12;
    expect([cone.base.diameter, cone.surface.diameter, cone.surface.length]).toEqual([5, 5, 12]);
  });

  it('cylinder: front base color and base visibility', () => {
    const cylinder = new Cylinder({ style: { backfaceColor: '#222' }, frontFaceColor: '#abc' });
    expect(cylinder.frontBase.style.backfaceColor).toBe('#abc');
    expect(cylinder.rearBase.style.backfaceColor).toBe('#222');
    cylinder.frontFaceColor = null;
    expect(cylinder.frontBase.style.backfaceColor).toBe('#222');
    cylinder.style.backfaceVisible = false;
    expect(cylinder.frontBase.style.backfaceVisible).toBe(true);
    expect(cylinder.rearBase.style.backfaceVisible).toBe(true);
  });

  it('box: size and position of all six faces', () => {
    const box = new Box();
    box.width = 3;
    box.height = 5;
    box.depth = 7;
    const expected: Record<string, [number, number, number, number, number]> = {
      front: [3, 5, 0, 0, 3.5],
      rear: [3, 5, 0, 0, -3.5],
      left: [7, 5, -1.5, 0, 0],
      right: [7, 5, 1.5, 0, 0],
      top: [3, 7, 0, -2.5, 0],
      bottom: [3, 7, 0, 2.5, 0],
    };
    for (const face of BOX_FACES) {
      const rect = box.faces[face];
      expect(
        [rect.width, rect.height, rect.position.x, rect.position.y, rect.position.z],
        face,
      ).toEqual(expected[face]);
    }
  });

  it('box: a face own color and visibility survive a style change', () => {
    const box = new Box({ faces: { top: { color: '#ff0' }, bottom: { visible: false } } });
    expect(box.faces.top.style.color).toBe('#ff0');
    expect(box.faces.bottom.visible).toBe(false);
    box.style.color = '#00f';
    box.style.stroke = 2;
    box.style.fill = false;
    expect([
      box.faces.top.style.color,
      box.faces.top.style.stroke,
      box.faces.top.style.fill,
    ]).toEqual(['#ff0', 2, false]);
    expect(box.faces.front.style.color).toBe('#00f');
    expect(box.faces.bottom.visible).toBe(false);
    box.setFace('top', { color: null });
    expect(box.faces.top.style.color).toBe('#00f');
    box.setFace('bottom', { visible: true, color: '#123' });
    expect([box.faces.bottom.visible, box.faces.bottom.style.color]).toEqual([true, '#123']);
    expect(box.getFace('bottom')).toEqual({ visible: true, color: '#123' });
    expect(Object.isFrozen(box.getFace('bottom'))).toBe(true);
  });

  it('solid style and parameters change its appearanceVersion and are validated', () => {
    const box = new Box();
    const version = box.appearanceVersion;
    box.style.stroke = 3;
    box.setFace('left', { visible: false });
    box.setFace('left', { visible: false });
    expect(box.appearanceVersion).toBe(version + 2);
    expect(() => {
      box.width = -1;
    }).toThrow(RangeError);
    expect(box.width).toBe(1);
    expect(() => new Cylinder({ diameter: Number.NaN })).toThrow(RangeError);
    expect(() => new Sphere({ diameter: -2 })).toThrow(RangeError);
  });

  it('defaults as in Zdog: fill on, stroke 1', () => {
    for (const solid of [new Box(), new Cylinder(), new Cone(), new Hemisphere()]) {
      expect([solid.style.fill, solid.style.stroke]).toEqual([true, 1]);
    }
    expect(new Sphere().style.fill).toBe(true);
  });
});

describe('solid parts', () => {
  it('owner and ids of the form "shape/key", registration in the scene', () => {
    const scene = new Scene();
    const box = new Box({ id: 'crate' });
    const cylinder = new Cylinder({ id: 'can' });
    scene.root.add(box).add(cylinder);
    expect(box.faces.top.id).toBe('crate/top');
    expect(box.faces.top.owner).toBe(box);
    expect(scene.getById('crate/left')).toBe(box.faces.left);
    expect([cylinder.body.id, cylinder.frontBase.id, cylinder.rearBase.id]).toEqual([
      'can/body',
      'can/front',
      'can/rear',
    ]);
    expect(box.owner).toBeNull();
    expect(() => new Node({ id: 'a/b' })).toThrow(RangeError);
  });

  it('destroying a solid unregisters part ids', () => {
    const scene = new Scene();
    const box = new Box({ id: 'crate' });
    scene.root.add(box);
    box.destroy();
    for (const face of BOX_FACES) expect(scene.getById(`crate/${face}`)).toBeNull();
  });
});

describe('screen parts allocate no objects on rebuild', () => {
  it('surface buffers are reused', () => {
    const cone = new Cone({ diameter: 10, length: 20, rotation: euler.create(0.5, 0.3, 0) });
    const camera = new Camera();
    const out = new SurfaceOutline();
    expect(cone.surface.buildOutline(camera, out)).toBe(true);
    const { ops, data } = out.path;
    for (let i = 0; i < 20; i++) {
      cone.rotation.x = 0.5 + i * 0.01;
      cone.surface.buildOutline(camera, out);
    }
    expect(out.path.ops).toBe(ops);
    expect(out.path.data).toBe(data);
  });
});
