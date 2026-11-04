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
  Hemisphere,
  Node,
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
    lineWidth: out.stroke ? out.lineWidth : null,
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

describe('экранные части совпадают с Zdog', () => {
  it('купол полусферы', () => {
    for (const rotate of ROTATIONS) {
      const zdogRoot = new Zdog.Anchor({ rotate });
      const zdog = new Zdog.Hemisphere({
        addTo: zdogRoot,
        diameter: 40,
        stroke: 3,
        translate: { x: 5, y: -2 },
      });
      zdogRoot.updateGraph();
      const { recorded, ctx, renderer } = recorder();
      (zdog as unknown as { renderDome(c: unknown, r: unknown): void }).renderDome(ctx, renderer);

      const root = rootFor(rotate);
      const ours = new Hemisphere({
        diameter: 40,
        style: { stroke: 3 },
        position: { x: 5, y: -2, z: 0 },
      });
      root.add(ours);
      const actual = outlineOf(ours.dome);
      if (!actual) throw new Error('купол должен рисоваться');
      expectSame(actual, recorded, JSON.stringify(rotate));
    }
  });

  it('боковая поверхность цилиндра', () => {
    for (const rotate of ROTATIONS) {
      const zdogRoot = new Zdog.Anchor({ rotate });
      const zdog = new Zdog.Cylinder({ addTo: zdogRoot, diameter: 30, length: 50, stroke: 2 });
      zdogRoot.updateGraph();
      const { recorded, ctx, renderer } = recorder();
      const group = (
        zdog as unknown as { group: { renderCylinderSurface(c: unknown, r: unknown): void } }
      ).group;
      group.renderCylinderSurface(ctx, renderer);

      const root = rootFor(rotate);
      const ours = new Cylinder({ diameter: 30, length: 50, style: { stroke: 2 } });
      root.add(ours);
      const actual = outlineOf(ours.body);
      if (!actual) throw new Error('бок цилиндра должен рисоваться');
      expectSame(actual, recorded, JSON.stringify(rotate));
    }
  });

  it('поверхность конуса, включая ракурс, где её не видно', () => {
    let hidden = 0;
    const rotations = [...ROTATIONS, { x: 0, y: 0, z: 0 }, { x: Math.PI, y: 0, z: 0 }];
    for (const rotate of rotations) {
      const zdogRoot = new Zdog.Anchor({ rotate });
      const zdog = new Zdog.Cone({ addTo: zdogRoot, diameter: 30, length: 40, stroke: 2 });
      zdogRoot.updateGraph();
      const { recorded, ctx, renderer } = recorder();
      (zdog as unknown as { renderConeSurface(c: unknown, r: unknown): void }).renderConeSurface(
        ctx,
        renderer,
      );

      const root = rootFor(rotate);
      const ours = new Cone({ diameter: 30, length: 40, style: { stroke: 2 } });
      root.add(ours);
      const actual = outlineOf(ours.surface);
      if (recorded.ops.length === 0) {
        hidden++;
        expect(actual, JSON.stringify(rotate)).toBeNull();
      } else {
        if (!actual) throw new Error('поверхность конуса должна рисоваться');
        expectSame(actual, recorded, JSON.stringify(rotate));
      }
    }
    expect(hidden).toBeGreaterThan(0);
  });

  it('основания и грани — обычные фигуры в тех же мировых точках, что у Zdog', () => {
    for (const rotate of ROTATIONS) {
      const zdogRoot = new Zdog.Anchor({ rotate });
      const zdogBox = new Zdog.Box({ addTo: zdogRoot, width: 20, height: 30, depth: 40 });
      const zdogCylinder = new Zdog.Cylinder({ addTo: zdogRoot, diameter: 16, length: 24 });
      zdogRoot.updateGraph();

      const root = rootFor(rotate);
      const box = new Box({ width: 20, height: 30, depth: 40 });
      const cylinder = new Cylinder({ diameter: 16, length: 24 });
      root.add(box).add(cylinder);

      const zdogFaces = (zdogBox.children as unknown as ZdogShape[]).filter((c) => c.pathCommands);
      const ourFaces = BOX_FACES.map((face) => box.faces[face]);
      expect(zdogFaces).toHaveLength(6);
      ourFaces.forEach((face, i) => {
        expectWorldPath(face, zdogFaces[i] as ZdogShape);
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

/** Мировые точки пути нашей фигуры против точек Zdog после updateGraph (без дуг: концы команд). */
function expectWorldPath(shape: Shape, zdog: ZdogShape): void {
  const geometry = shape.geometry;
  const ours: number[] = [];
  const point = vec3.create();
  for (let i = 0; i < geometry.pointCount; i++) {
    shape.localToWorld(point, {
      x: geometry.points[i * 3] ?? 0,
      y: geometry.points[i * 3 + 1] ?? 0,
      z: geometry.points[i * 3 + 2] ?? 0,
    });
    ours.push(point.x, point.y, point.z);
  }
  // У Zdog дуга хранит угол и конец, у нас — две опорные точки и конец; сравниваем концы команд.
  const zdogEnds = zdog.pathCommands.map((c) => c.renderPoints[c.renderPoints.length - 1]);
  const ourEnds: number[] = [];
  let index = 0;
  for (let op = 0; op < geometry.opCount; op++) {
    index += geometry.ops[op] === 2 ? 3 : 1;
    ourEnds.push(...ours.slice((index - 1) * 3, index * 3));
  }
  expect(ourEnds.length).toBe(zdogEnds.length * 3);
  zdogEnds.forEach((end, i) => {
    expect(ourEnds[i * 3]).toBeCloseTo(end?.x ?? Number.NaN, 9);
    expect(ourEnds[i * 3 + 1]).toBeCloseTo(end?.y ?? Number.NaN, 9);
    expect(ourEnds[i * 3 + 2]).toBeCloseTo(end?.z ?? Number.NaN, 9);
  });
  // Лицевая сторона смотрит туда же: сравниваем мировую нормаль с нормалью Zdog.
  const origin = shape.localToWorld(vec3.create(), { x: 0, y: 0, z: 0 });
  const front = shape.localToWorld(vec3.create(), { x: 0, y: 0, z: 1 });
  expect(origin.x - front.x).toBeCloseTo(zdog.renderNormal.x, 9);
  expect(origin.y - front.y).toBeCloseTo(zdog.renderNormal.y, 9);
  expect(origin.z - front.z).toBeCloseTo(zdog.renderNormal.z, 9);
}

describe('сфера и капсула', () => {
  it('сфера — круг с радиусом по масштабу и zoom', () => {
    const sphere = new Sphere({
      diameter: 10,
      position: { x: 4, y: -3, z: 0 },
      scale: 2,
      style: { stroke: 1 },
    });
    const recorded = outlineOf(sphere, new Camera({ zoom: 3 }));
    expect(recorded?.ops).toEqual([ScreenOp.arc]);
    expect(recorded?.values).toEqual([12, -9, 30, 0, TAU, 0]);
    expect(recorded?.lineWidth).toBe(3);
  });

  it('капсула — толстый отрезок вдоль z, вырожденная — круг', () => {
    const capsule = new Capsule({
      length: 20,
      diameter: 6,
      rotation: euler.create(Math.PI / 2, 0, 0),
    });
    const recorded = outlineOf(capsule);
    expect(recorded?.ops).toEqual([ScreenOp.move, ScreenOp.line]);
    const [x1, y1, x2, y2] = recorded?.values ?? [];
    expect(Math.hypot((x2 ?? 0) - (x1 ?? 0), (y2 ?? 0) - (y1 ?? 0))).toBeCloseTo(20, 9);
    expect(recorded?.lineWidth).toBeCloseTo(7, 12);
    const end = outlineOf(new Capsule({ length: 20, diameter: 6 }));
    expect(end?.ops).toEqual([ScreenOp.arc]);
    expect(end?.lineWidth).toBeNull();
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
    const near = outlineOf(new Sphere({ diameter: 10, position: { x: 0, y: 0, z: 50 } }), camera);
    const far = outlineOf(new Sphere({ diameter: 10, position: { x: 0, y: 0, z: -100 } }), camera);
    expect(near?.values[2]).toBeCloseTo(10, 12);
    expect(far?.values[2]).toBeCloseTo(2.5, 12);
  });
});

describe('составные фигуры передают стиль и параметры детям', () => {
  it('полусфера, цилиндр и конус', () => {
    const hemisphere = new Hemisphere({ diameter: 8, style: { color: '#f00' } });
    hemisphere.diameter = 12;
    hemisphere.style.color = '#0f0';
    expect([hemisphere.base.diameter, hemisphere.dome.diameter]).toEqual([12, 12]);
    expect([hemisphere.base.style.color, hemisphere.dome.style.color]).toEqual(['#0f0', '#0f0']);

    const cylinder = new Cylinder({
      length: 10,
      style: { backfaceColor: '#222' },
      frontFaceColor: '#abc',
    });
    cylinder.length = 30;
    expect([
      cylinder.frontBase.position.z,
      cylinder.rearBase.position.z,
      cylinder.body.length,
    ]).toEqual([15, -15, 30]);
    expect(cylinder.frontBase.style.backfaceColor).toBe('#abc');
    expect(cylinder.rearBase.style.backfaceColor).toBe('#222');
    cylinder.frontFaceColor = null;
    expect(cylinder.frontBase.style.backfaceColor).toBe('#222');
    cylinder.style.backfaceVisible = false;
    expect(cylinder.frontBase.style.backfaceVisible).toBe(true);

    const cone = new Cone({ diameter: 4, length: 9 });
    cone.length = 12;
    cone.style.fill = false;
    expect([cone.surface.length, cone.base.style.fill, cone.surface.style.fill]).toEqual([
      12,
      false,
      false,
    ]);
  });

  it('коробка: размеры, цвета и отключение граней', () => {
    const box = new Box({ width: 2, height: 4, depth: 6, faces: { top: '#ff0', bottom: false } });
    expect(box.faces.top.style.color).toBe('#ff0');
    expect(box.faces.bottom.visible).toBe(false);
    expect([box.faces.left.width, box.faces.left.height]).toEqual([6, 4]);
    expect([box.faces.top.width, box.faces.top.height]).toEqual([2, 6]);
    box.style.color = '#00f';
    expect(box.faces.front.style.color).toBe('#00f');
    expect(box.faces.top.style.color).toBe('#ff0');
    box.setFace('top', true);
    expect(box.faces.top.style.color).toBe('#00f');
    box.setFace('bottom', '#123');
    expect([box.faces.bottom.visible, box.faces.bottom.style.color]).toEqual([true, '#123']);
    box.depth = 10;
    expect(box.faces.front.position.z).toBe(5);
    expect(box.getFace('bottom')).toBe('#123');
  });

  it('стиль и параметры составной фигуры меняют её appearanceVersion и проверяются', () => {
    const box = new Box();
    const version = box.appearanceVersion;
    box.style.stroke = 3;
    box.setFace('left', false);
    expect(box.appearanceVersion).toBe(version + 2);
    expect(() => {
      box.width = -1;
    }).toThrow(RangeError);
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

describe('экранные части не создают объектов при повторной сборке', () => {
  it('буферы контура переиспользуются', () => {
    const cone = new Cone({ diameter: 10, length: 20, rotation: euler.create(0.5, 0.3, 0) });
    const camera = new Camera();
    const out = new SurfaceOutline();
    cone.surface.buildOutline(camera, out);
    const { ops, data } = out.path;
    for (let i = 0; i < 20; i++) {
      cone.rotation.x = 0.5 + i * 0.01;
      cone.surface.buildOutline(camera, out);
    }
    expect(out.path.ops).toBe(ops);
    expect(out.path.data).toBe(data);
  });
});
