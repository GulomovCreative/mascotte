import { euler, TAU, vec3 } from '@mascotte/math';
import Zdog from '@mascotte/zdog-reference';
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

/** Повороты, при которых видны разные стороны фигур. */
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

/** Контекст и рендерер Zdog, которые записывают, что рисуется. */
function recorder() {
  const recorded: Recorded = { ops: [], values: [], lineWidth: null, lineCap: 'round' };
  const ctx = {
    beginPath() {},
    arc(x: number, y: number, r: number, start: number, end: number) {
      recorded.ops.push(ScreenOp.arc);
      recorded.values.push(x, y, r, start, end, 0);
    },
    set lineCap(value: string) {
      if (value === 'butt') recorded.lineCap = value;
    },
  };
  const point = (p: { x: number; y: number }) => recorded.values.push(p.x, p.y);
  const renderer = {
    isCanvas: true,
    move: (_c: unknown, _e: unknown, p: { x: number; y: number }) => {
      recorded.ops.push(ScreenOp.move);
      point(p);
    },
    line: (_c: unknown, _e: unknown, p: { x: number; y: number }) => {
      recorded.ops.push(ScreenOp.line);
      point(p);
    },
    renderPath(
      c: unknown,
      e: unknown,
      commands: { render(c: unknown, e: unknown, r: unknown): void }[],
    ) {
      for (const command of commands) command.render(c, e, renderer);
    },
    stroke(_c: unknown, _e: unknown, isStroke: unknown, _color: string, width: number) {
      recorded.lineWidth = isStroke ? width : null;
    },
    fill() {},
    end() {},
  };
  return { recorded, ctx, renderer };
}

function expectSame(actual: Recorded, expected: Recorded, label: string): void {
  expect(actual.ops, label).toEqual(expected.ops);
  expect(actual.lineCap, label).toBe(expected.lineCap);
  if (expected.lineWidth === null) expect(actual.lineWidth, label).toBeNull();
  else expect(actual.lineWidth, label).toBeCloseTo(expected.lineWidth, 9);
  expect(actual.values.length, label).toBe(expected.values.length);
  actual.values.forEach((value, i) => {
    expect(value, `${label}: число ${i}`).toBeCloseTo(expected.values[i] ?? Number.NaN, 9);
  });
}

/** Узел-корень с поворотом Zdog {x, y, z} в нашей системе ({x, -y, z}). */
function rootFor(rotate: { x: number; y: number; z: number }): Node {
  return new Node({ rotation: euler.create(rotate.x, -rotate.y, rotate.z) });
}

function outlineOf(surface: Surface, camera = new Camera()): Recorded | null {
  const out = new SurfaceOutline();
  return surface.buildOutline(camera, out) ? fromOutline(out) : null;
}

/** Контур, который обязан построиться. */
function mustOutline(surface: Surface, camera = new Camera()): Recorded {
  const recorded = outlineOf(surface, camera);
  if (!recorded) throw new Error(`контур ${surface.id} должен строиться`);
  return recorded;
}

function scaled(recorded: Recorded, factor: number): Recorded {
  return {
    ...recorded,
    values: recorded.values.map((v, i) =>
      // У дуги углы (4-е и 5-е числа) и направление не масштабируются.
      recorded.ops[0] === ScreenOp.arc && i % 6 >= 3 ? v : v * factor,
    ),
    lineWidth: recorded.lineWidth === null ? null : recorded.lineWidth * factor,
  };
}

/** Zdog-сцена и наша сцена с одинаковыми корнем, сдвигом и масштабом. */
interface Setup {
  rotate: { x: number; y: number; z: number };
  scale?: number;
  translate?: { x: number; y: number; z: number };
  zoom?: number;
  nested?: boolean;
}

function zdogParent(setup: Setup) {
  const root = new Zdog.Anchor({ rotate: setup.rotate });
  const holder = new Zdog.Anchor({
    addTo: root,
    scale: setup.scale ?? 1,
    translate: setup.translate ?? { x: 0, y: 0, z: 0 },
  });
  const inner = setup.nested ? new Zdog.Anchor({ addTo: holder, rotate: { z: 0.4 } }) : holder;
  return { root, parent: inner };
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
 * При масштабе узла ≠ 1 обводка у нас масштабируется, а у Zdog — нет. Поэтому при
 * масштабе сравнение идёт без обводки, а масштаб обводки проверяется отдельно.
 */
function strokeFor(setup: Setup, stroke: number): number {
  return (setup.scale ?? 1) === 1 ? stroke : 0;
}

describe('экранные части совпадают с Zdog', () => {
  it('купол полусферы', () => {
    for (const setup of SETUPS) {
      const stroke = strokeFor(setup, 3);
      const { root, parent } = zdogParent(setup);
      const zdog = new Zdog.Hemisphere({
        addTo: parent,
        diameter: 40,
        stroke,
        translate: { x: 5, y: -2 },
      });
      root.updateGraph();
      const { recorded, ctx, renderer } = recorder();
      (zdog as unknown as { renderDome(c: unknown, r: unknown): void }).renderDome(ctx, renderer);

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

  it('боковая поверхность цилиндра', () => {
    for (const setup of SETUPS) {
      const stroke = strokeFor(setup, 2);
      const { root, parent } = zdogParent(setup);
      const zdog = new Zdog.Cylinder({ addTo: parent, diameter: 30, length: 50, stroke });
      root.updateGraph();
      const { recorded, ctx, renderer } = recorder();
      const group = (
        zdog as unknown as { group: { renderCylinderSurface(c: unknown, r: unknown): void } }
      ).group;
      group.renderCylinderSurface(ctx, renderer);

      const ours = new Cylinder({ diameter: 30, length: 50, style: { stroke } });
      ourParent(setup).add(ours);
      const zoom = setup.zoom ?? 1;
      const actual = mustOutline(ours.body, new Camera({ zoom }));
      expectSame(actual, scaled(recorded, zoom), JSON.stringify(setup));
    }
  });

  it('поверхность конуса, включая ракурс, где её не видно', () => {
    let hidden = 0;
    const setups: Setup[] = [
      ...SETUPS,
      { rotate: { x: 0, y: 0, z: 0 } },
      { rotate: { x: Math.PI, y: 0, z: 0 } },
    ];
    for (const setup of setups) {
      const stroke = strokeFor(setup, 2);
      const { root, parent } = zdogParent(setup);
      const zdog = new Zdog.Cone({ addTo: parent, diameter: 30, length: 40, stroke });
      root.updateGraph();
      const { recorded, ctx, renderer } = recorder();
      (zdog as unknown as { renderConeSurface(c: unknown, r: unknown): void }).renderConeSurface(
        ctx,
        renderer,
      );

      const ours = new Cone({ diameter: 30, length: 40, style: { stroke } });
      ourParent(setup).add(ours);
      const zoom = setup.zoom ?? 1;
      const actual = outlineOf(ours.surface, new Camera({ zoom }));
      if (recorded.ops.length === 0) {
        hidden++;
        expect(actual, JSON.stringify(setup)).toBeNull();
      } else {
        if (!actual) throw new Error('поверхность конуса должна рисоваться');
        expectSame(actual, scaled(recorded, zoom), JSON.stringify(setup));
      }
    }
    expect(hidden).toBeGreaterThan(0);
  });

  it('основания и грани — обычные фигуры в тех же мировых точках, что у Zdog', () => {
    for (const setup of SETUPS) {
      const { root, parent } = zdogParent(setup);
      const zdogBox = new Zdog.Box({ addTo: parent, width: 20, height: 30, depth: 40 });
      const zdogCylinder = new Zdog.Cylinder({ addTo: parent, diameter: 16, length: 24 });
      root.updateGraph();

      const box = new Box({ width: 20, height: 30, depth: 40 });
      const cylinder = new Cylinder({ diameter: 16, length: 24 });
      ourParent(setup).add(box).add(cylinder);

      const zdogFaces = (zdogBox.children as unknown as ZdogShape[]).filter((c) => c.pathCommands);
      expect(zdogFaces).toHaveLength(6);
      BOX_FACES.forEach((face, i) => {
        expectWorldPath(box.faces[face], zdogFaces[i] as ZdogShape);
      });

      const zdogBases = zdogCylinder as unknown as { frontBase: ZdogShape; rearBase: ZdogShape };
      expectWorldPath(cylinder.frontBase, zdogBases.frontBase);
      expectWorldPath(cylinder.rearBase, zdogBases.rearBase);
    }
  });
});

interface ZdogShape {
  pathCommands: { renderPoints: { x: number; y: number; z: number }[] }[];
  renderNormal: { x: number; y: number; z: number };
}

/** Мировые концы команд пути нашей фигуры против точек Zdog после updateGraph. */
function expectWorldPath(shape: Shape, zdog: ZdogShape): void {
  const geometry = shape.geometry;
  const point = vec3.create();
  const ourEnds: number[] = [];
  let index = 0;
  for (let op = 0; op < geometry.opCount; op++) {
    // У дуги и кривой три точки, конец — последняя.
    index += geometry.ops[op] === 2 ? 3 : 1;
    const i = (index - 1) * 3;
    shape.localToWorld(point, {
      x: geometry.points[i] ?? 0,
      y: geometry.points[i + 1] ?? 0,
      z: geometry.points[i + 2] ?? 0,
    });
    ourEnds.push(point.x, point.y, point.z);
  }
  const zdogEnds = zdog.pathCommands.map((c) => c.renderPoints[c.renderPoints.length - 1]);
  expect(ourEnds.length).toBe(zdogEnds.length * 3);
  zdogEnds.forEach((end, i) => {
    expect(ourEnds[i * 3]).toBeCloseTo(end?.x ?? Number.NaN, 9);
    expect(ourEnds[i * 3 + 1]).toBeCloseTo(end?.y ?? Number.NaN, 9);
    expect(ourEnds[i * 3 + 2]).toBeCloseTo(end?.z ?? Number.NaN, 9);
  });
  // Лицевая сторона смотрит туда же: мировая нормаль как у Zdog.
  const origin = shape.localToWorld(vec3.create(), { x: 0, y: 0, z: 0 });
  const front = shape.localToWorld(vec3.create(), { x: 0, y: 0, z: 1 });
  expect(origin.x - front.x).toBeCloseTo(zdog.renderNormal.x, 9);
  expect(origin.y - front.y).toBeCloseTo(zdog.renderNormal.y, 9);
  expect(origin.z - front.z).toBeCloseTo(zdog.renderNormal.z, 9);
}

describe('перспектива составных фигур', () => {
  const camera = new Camera({ projection: 'perspective', distance: 100 });

  it('бок цилиндра сходится с центрами оснований, спроецированными по глубине цилиндра', () => {
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
    // Толщина — по масштабу глубины цилиндра, а не концов.
    expect(body.lineWidth).toBeCloseTo((20 + 1) * camera.scaleAt(depth), 9);
  });

  it('все части составной фигуры берут глубину владельца', () => {
    const cone = new Cone();
    const box = new Box();
    for (const part of [cone.surface, cone.base, ...BOX_FACES.map((f) => box.faces[f])]) {
      expect(part.perspectiveReference).toBe(part.owner);
    }
    const sphere = new Sphere();
    expect(sphere.perspectiveReference).toBe(sphere);
  });

  it('купол и конус в перспективе: координаты и толщина умножаются на масштаб глубины', () => {
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
      // Сдвиг по z не меняет x и y в пространстве камеры; масштаб на глубине 50 — 2.
      expectSame(actual, scaled(base, 2), flat.constructor.name);
    }
  });
});

describe('сфера и капсула', () => {
  it('сфера — круг; радиус и обводка масштабируются вместе с узлом', () => {
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

  it('сфера при неравномерном масштабе берёт масштаб по x', () => {
    const recorded = mustOutline(new Sphere({ diameter: 10, scale: { x: 2, y: 5, z: 7 } }));
    expect(recorded.values[2]).toBe(10);
  });

  it('капсула — толстый отрезок вдоль z, вырожденная — круг', () => {
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
    // Толщина берёт масштаб по x: (6 + 1) · 2.
    expect(recorded.lineWidth).toBeCloseTo(14, 12);
    const end = mustOutline(new Capsule({ length: 20, diameter: 6 }));
    expect(end.ops).toEqual([ScreenOp.arc]);
    expect(end.lineWidth).toBeNull();
    expect(end.values[2]).toBeCloseTo(3.5, 12);
  });

  it('за глазом перспективной камеры поверхность не рисуется', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100 });
    for (const surface of [
      new Sphere({ position: { x: 0, y: 0, z: 150 } }),
      new Capsule({ position: { x: 0, y: 0, z: 150 } }),
    ]) {
      expect(outlineOf(surface, camera)).toBeNull();
    }
  });

  it('перспектива увеличивает ближнюю сферу', () => {
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

describe('кисть контура', () => {
  it('заливка, обводка, цвет и концы линий у каждой поверхности', () => {
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

describe('вырожденный конус', () => {
  it('нулевые размеры и масштаб не дают NaN', () => {
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

describe('составные фигуры передают стиль и параметры детям', () => {
  it('каждое поле стиля доходит до каждой части', () => {
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

  it('параметры доходят до каждой части', () => {
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

  it('цилиндр: цвет переднего основания и видимость оснований', () => {
    const cylinder = new Cylinder({ style: { backfaceColor: '#222' }, frontFaceColor: '#abc' });
    expect(cylinder.frontBase.style.backfaceColor).toBe('#abc');
    expect(cylinder.rearBase.style.backfaceColor).toBe('#222');
    cylinder.frontFaceColor = null;
    expect(cylinder.frontBase.style.backfaceColor).toBe('#222');
    cylinder.style.backfaceVisible = false;
    expect(cylinder.frontBase.style.backfaceVisible).toBe(true);
    expect(cylinder.rearBase.style.backfaceVisible).toBe(true);
  });

  it('коробка: размеры и положение всех шести граней', () => {
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

  it('коробка: свой цвет и видимость грани переживают смену стиля', () => {
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

  it('стиль и параметры составной фигуры меняют её appearanceVersion и проверяются', () => {
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

  it('значения по умолчанию как в Zdog: заливка включена, обводка 1', () => {
    for (const solid of [new Box(), new Cylinder(), new Cone(), new Hemisphere()]) {
      expect([solid.style.fill, solid.style.stroke]).toEqual([true, 1]);
    }
    expect(new Sphere().style.fill).toBe(true);
  });
});

describe('части составной фигуры', () => {
  it('owner и id вида «фигура/ключ», регистрация в сцене', () => {
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

  it('уничтожение составной фигуры снимает id частей', () => {
    const scene = new Scene();
    const box = new Box({ id: 'crate' });
    scene.root.add(box);
    box.destroy();
    for (const face of BOX_FACES) expect(scene.getById(`crate/${face}`)).toBeNull();
  });
});

describe('экранные части не создают объектов при повторной сборке', () => {
  it('буферы контура переиспользуются', () => {
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
