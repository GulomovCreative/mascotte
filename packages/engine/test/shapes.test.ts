import Zdog from '@mascotte/zdog-reference';
import { describe, expect, it } from 'vitest';
import {
  ARC_HANDLE,
  Ellipse,
  PathBuilder,
  type PathGeometry,
  PathOp,
  PathShape,
  Polygon,
  Rect,
  RoundedRect,
  type Shape,
} from '../src/index.ts';

interface Recorded {
  ops: number[];
  points: number[];
  closed: boolean;
}

function fromGeometry(geometry: PathGeometry): Recorded {
  return {
    ops: Array.from(geometry.ops.subarray(0, geometry.opCount)),
    points: Array.from(geometry.points.subarray(0, geometry.pointCount * 3)),
    closed: geometry.closed,
  };
}

/** Рисует фигуру Zdog рендерером-заглушкой, который записывает команды пути. */
function fromZdog(shape: unknown): Recorded {
  const recorded: Recorded = { ops: [], points: [], closed: false };
  const push = (...points: { x: number; y: number; z: number }[]) => {
    for (const p of points) recorded.points.push(p.x, p.y, p.z);
  };
  const renderer = {
    isCanvas: false,
    isSvg: false,
    move: (_c: unknown, _e: unknown, p: { x: number; y: number; z: number }) => {
      recorded.ops.push(PathOp.move);
      push(p);
    },
    line: (_c: unknown, _e: unknown, p: { x: number; y: number; z: number }) => {
      recorded.ops.push(PathOp.line);
      push(p);
    },
    bezier: (
      _c: unknown,
      _e: unknown,
      a: { x: number; y: number; z: number },
      b: { x: number; y: number; z: number },
      p: { x: number; y: number; z: number },
    ) => {
      recorded.ops.push(PathOp.cubic);
      push(a, b, p);
    },
    renderPath(
      ctx: unknown,
      elem: unknown,
      commands: { render(c: unknown, e: unknown, r: unknown): void }[],
      closed: boolean,
    ) {
      for (const command of commands) command.render(ctx, elem, renderer);
      recorded.closed = closed;
    },
    stroke() {},
    fill() {},
    end() {},
  };
  const zdog = shape as { updateGraph(): void; render(ctx: unknown, renderer: unknown): void };
  zdog.updateGraph();
  zdog.render(null, renderer);
  return recorded;
}

function expectSamePath(ours: Shape, zdog: unknown): void {
  const a = fromGeometry(ours.geometry);
  const b = fromZdog(zdog);
  expect(a.ops).toEqual(b.ops);
  expect(a.closed).toBe(b.closed);
  expect(a.points).toHaveLength(b.points.length);
  a.points.forEach((value, i) => {
    expect(value, `точка ${i}`).toBeCloseTo(b.points[i] ?? Number.NaN, 12);
  });
}

describe('геометрия совпадает с Zdog', () => {
  it('эллипс, все варианты четвертей', () => {
    for (const quarters of [1, 2, 3, 4]) {
      expectSamePath(
        new Ellipse({ width: 30, height: 18, quarters }),
        new Zdog.Ellipse({ width: 30, height: 18, quarters }),
      );
    }
    expectSamePath(new Ellipse({ diameter: 12 }), new Zdog.Ellipse({ diameter: 12 }));
  });

  it('прямоугольник', () => {
    expectSamePath(new Rect({ width: 40, height: 20 }), new Zdog.Rect({ width: 40, height: 20 }));
  });

  it('скруглённый прямоугольник, включая радиус больше половины стороны и квадрат', () => {
    const cases = [
      { width: 60, height: 40, cornerRadius: 10 },
      { width: 60, height: 40, cornerRadius: 50 },
      { width: 30, height: 30, cornerRadius: 15 },
      { width: 30, height: 30, cornerRadius: 0 },
    ];
    for (const options of cases) {
      expectSamePath(new RoundedRect(options), new Zdog.RoundedRect(options));
    }
  });

  it('многоугольник', () => {
    for (const sides of [3, 5, 8]) {
      expectSamePath(new Polygon({ radius: 25, sides }), new Zdog.Polygon({ radius: 25, sides }));
    }
  });

  it('путь с отрезками, дугой и кривой Безье, открытый и замкнутый', () => {
    const zdogPath = [
      { x: -20, y: -20 },
      {
        arc: [
          { x: 20, y: -20 },
          { x: 20, y: 20 },
        ],
      },
      {
        bezier: [
          { x: 0, y: 0, z: 5 },
          { x: 0, y: 40 },
          { x: -20, y: 20 },
        ],
      },
      { line: { x: -25, y: 0, z: -3 } },
    ] as const;
    for (const closed of [false, true]) {
      const ours = new PathShape({
        closed,
        path: [
          { type: 'move', point: { x: -20, y: -20 } },
          { type: 'arc', corner: { x: 20, y: -20 }, point: { x: 20, y: 20 } },
          {
            type: 'bezier',
            control1: { x: 0, y: 0, z: 5 },
            control2: { x: 0, y: 40 },
            point: { x: -20, y: 20 },
          },
          { type: 'line', point: { x: -25, y: 0, z: -3 } },
        ],
      });
      expectSamePath(ours, new Zdog.Shape({ closed, path: zdogPath as never }));
    }
  });

  it('точка и отрезок: отрезок не замыкается', () => {
    expectSamePath(new PathShape(), new Zdog.Shape({}));
    const segment = [
      { type: 'move', point: { x: -30 } },
      { type: 'line', point: { x: 30 } },
    ] as const;
    expectSamePath(
      new PathShape({ path: segment }),
      new Zdog.Shape({ path: [{ x: -30 }, { x: 30 }] }),
    );
    expect(new PathShape({ path: segment }).geometry.closed).toBe(false);
  });
});

describe('PathBuilder', () => {
  it('первая команда становится move в её конечной точке', () => {
    for (const build of [
      (b: PathBuilder) => b.lineTo(1, 2, 3),
      (b: PathBuilder) => b.arcTo(9, 9, 9, 1, 2, 3),
      (b: PathBuilder) => b.bezierTo(9, 9, 9, 8, 8, 8, 1, 2, 3),
    ]) {
      const geometry = fromGeometry(build(new PathBuilder()));
      expect(geometry.ops).toEqual([PathOp.move]);
      expect(geometry.points).toEqual([1, 2, 3]);
    }
  });

  it('дуга — кривая с ручками 9/16 к углу', () => {
    const geometry = fromGeometry(new PathBuilder().moveTo(0, 0, 0).arcTo(16, 0, 0, 16, 16, 0));
    expect(geometry.ops).toEqual([PathOp.move, PathOp.cubic]);
    expect(geometry.points).toEqual([
      0,
      0,
      0,
      16 * ARC_HANDLE,
      0,
      0,
      16,
      16 - 16 * ARC_HANDLE,
      0,
      16,
      16,
      0,
    ]);
  });

  it('буферы растут и переиспользуются после reset', () => {
    const builder = new PathBuilder();
    for (let i = 0; i < 100; i++) builder.lineTo(i, 0, 0);
    expect(builder.opCount).toBe(100);
    expect(builder.points[99 * 3]).toBe(99);
    const ops = builder.ops;
    builder.reset().moveTo(5, 5, 5);
    expect(builder.ops).toBe(ops);
    expect(fromGeometry(builder).points).toEqual([5, 5, 5]);
  });

  it('finish: два отрезка замыкаются, один — нет', () => {
    const one = new PathBuilder().moveTo(0, 0, 0).lineTo(1, 0, 0).finish(true);
    expect(one.closed).toBe(false);
    const curve = new PathBuilder()
      .moveTo(0, 0, 0)
      .bezierTo(0, 1, 0, 1, 1, 0, 1, 0, 0)
      .finish(true);
    expect(curve.closed).toBe(true);
    const two = new PathBuilder().moveTo(0, 0, 0).lineTo(1, 0, 0).lineTo(1, 1, 0).finish(true);
    expect(two.closed).toBe(true);
  });
});

describe('ленивая геометрия', () => {
  it('пересобирается только после изменения параметра', () => {
    const ellipse = new Ellipse({ diameter: 10 });
    const version = ellipse.geometryVersion;
    ellipse.geometry;
    ellipse.width = 10;
    ellipse.position.x = 50;
    ellipse.color = '#f00';
    expect(ellipse.geometryVersion).toBe(version);
    ellipse.width = 20;
    ellipse.quarters = 2;
    expect(ellipse.geometryVersion).toBe(version + 1);
    expect(fromGeometry(ellipse.geometry).points.slice(3, 6)).toEqual([10 * ARC_HANDLE, -5, 0]);
  });

  it('буферы геометрии переиспользуются при анимации параметра', () => {
    const rect = new RoundedRect({ width: 40, height: 20, cornerRadius: 5 });
    const { ops, points } = rect.geometry;
    for (let i = 1; i <= 30; i++) {
      rect.width = 40 + i;
      rect.geometry;
    }
    expect(rect.geometry.ops).toBe(ops);
    expect(rect.geometry.points).toBe(points);
  });

  it('closed меняет геометрию, стиль — только внешний вид', () => {
    const rect = new Rect();
    expect(rect.geometry.closed).toBe(true);
    const geometry = rect.geometryVersion;
    const appearance = rect.appearanceVersion;
    rect.stroke = 4;
    rect.fill = true;
    rect.backface = '#000';
    rect.front.z = -1;
    expect(rect.appearanceVersion).toBe(appearance + 4);
    expect(rect.geometryVersion).toBe(geometry);
    rect.closed = false;
    expect(rect.geometry.closed).toBe(false);
    expect(rect.geometryVersion).toBe(geometry + 1);
  });

  it('diameter задаёт ширину и высоту', () => {
    const ellipse = new Ellipse({ width: 4, height: 8 });
    ellipse.diameter = 6;
    expect([ellipse.width, ellipse.height, ellipse.diameter]).toEqual([6, 6, 6]);
  });

  it('PathShape.path копирует и замораживает путь', () => {
    const path = [
      { type: 'move', point: { x: 1 } },
      { type: 'line', point: { x: 2 } },
    ] as const;
    const shape = new PathShape({ path: [...path] });
    expect(Object.isFrozen(shape.path)).toBe(true);
    const version = shape.geometryVersion;
    shape.path = [{ type: 'move', point: { y: 3 } }];
    expect(shape.geometryVersion).toBe(version + 1);
    expect(fromGeometry(shape.geometry).points).toEqual([0, 3, 0]);
    expect(() => {
      shape.path = [];
    }).toThrow(RangeError);
  });
});

describe('проверка параметров', () => {
  it('размеры, обводка, четверти и стороны', () => {
    const bad = [-1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of bad) {
      expect(() => new Rect({ width: value })).toThrow(RangeError);
      expect(() => new Ellipse({ diameter: value })).toThrow(RangeError);
      expect(() => new RoundedRect({ cornerRadius: value })).toThrow(RangeError);
      expect(() => new Polygon({ radius: value })).toThrow(RangeError);
      expect(() => new PathShape({ stroke: value })).toThrow(RangeError);
    }
    for (const quarters of [0, 5, 2.5]) {
      expect(() => new Ellipse({ quarters })).toThrow(RangeError);
    }
    for (const sides of [2, 4.5]) {
      expect(() => new Polygon({ sides })).toThrow(RangeError);
    }
    const ellipse = new Ellipse();
    expect(() => {
      ellipse.quarters = 0;
    }).toThrow(RangeError);
    expect(ellipse.quarters).toBe(4);
  });

  it('значения по умолчанию как в Zdog', () => {
    const shape = new PathShape();
    expect([shape.stroke, shape.fill, shape.color, shape.closed, shape.backface]).toEqual([
      1,
      false,
      '#333',
      true,
      true,
    ]);
    expect(new Ellipse().closed).toBe(false);
    expect(new RoundedRect().closed).toBe(false);
    expect(new Rect().closed).toBe(true);
    expect([new Polygon().sides, new Polygon().radius]).toEqual([3, 0.5]);
  });
});
