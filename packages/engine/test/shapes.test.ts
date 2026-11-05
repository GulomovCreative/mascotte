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
import { zdogFixture } from './zdog-fixture.ts';

const zdog = zdogFixture('shapes');

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

/** What defines a shape: type, sizes, path. Recorded together with the Zdog output. */
function shapeInput(shape: Shape): Record<string, unknown> {
  const input: Record<string, unknown> = { type: shape.typeName, closed: shape.closed };
  for (const name of ['width', 'height', 'quarters', 'cornerRadius', 'radius', 'sides', 'path']) {
    if (name in shape) input[name] = (shape as unknown as Record<string, unknown>)[name];
  }
  return input;
}

/** Our shape path against the path Zdog built for the same shape (test `key`). */
function expectSamePath(ours: Shape, key: string): void {
  const a = fromGeometry(ours.geometry);
  const b = zdog.next<Recorded>(key, shapeInput(ours));
  expect(a.ops).toEqual(b.ops);
  expect(a.closed).toBe(b.closed);
  expect(a.points).toHaveLength(b.points.length);
  a.points.forEach((value, i) => {
    expect(value, `point ${i}`).toBeCloseTo(b.points[i] ?? Number.NaN, 12);
  });
}

describe('geometry matches Zdog', () => {
  it('ellipse, all quarter variants', () => {
    for (const quarters of [1, 2, 3, 4]) {
      expectSamePath(
        new Ellipse({ width: 30, height: 18, quarters }),
        'ellipse, all quarter variants',
      );
    }
    expectSamePath(new Ellipse({ diameter: 12 }), 'ellipse, all quarter variants');
    expectSamePath(new Ellipse({ width: 30 }), 'ellipse, all quarter variants');
    expectSamePath(new Ellipse({ height: 18 }), 'ellipse, all quarter variants');
    expectSamePath(new Ellipse({ diameter: 10, height: 4 }), 'ellipse, all quarter variants');
  });

  it('rect', () => {
    expectSamePath(new Rect({ width: 40, height: 20 }), 'rect');
  });

  it('rounded rect, including a radius over half the side and a square', () => {
    const cases = [
      { width: 60, height: 40, cornerRadius: 10 },
      { width: 60, height: 40, cornerRadius: 50 },
      { width: 30, height: 30, cornerRadius: 15 },
      { width: 30, height: 30, cornerRadius: 0 },
    ];
    for (const options of cases) {
      expectSamePath(
        new RoundedRect(options),
        'rounded rect, including a radius over half the side and a square',
      );
    }
  });

  it('polygon', () => {
    for (const sides of [3, 5, 8, 64]) {
      expectSamePath(new Polygon({ radius: 25, sides }), 'polygon');
    }
  });

  it('path with lines, an arc and a Bezier curve, open and closed', () => {
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
      expectSamePath(ours, 'path with lines, an arc and a Bezier curve, open and closed');
    }
  });

  it('point and line: a line does not close', () => {
    expectSamePath(new PathShape(), 'point and line: a line does not close');
    const segment = [
      { type: 'move', point: { x: -30 } },
      { type: 'line', point: { x: 30 } },
    ] as const;
    expectSamePath(new PathShape({ path: segment }), 'point and line: a line does not close');
    expect(new PathShape({ path: segment }).geometry.closed).toBe(false);
  });
});

function valuesOf(style: Shape['style']) {
  const { stroke, fill, color, backfaceVisible, backfaceColor } = style;
  return { stroke, fill, color, backfaceVisible, backfaceColor };
}

describe('PathBuilder', () => {
  it('buffer growth exactly at the capacity boundary keeps all points', () => {
    const builder = new PathBuilder().moveTo(0, 0, 0);
    for (let i = 1; i <= 4; i++) builder.lineTo(i, 0, 0);
    // 5 points out of 8 that fit: a curve adds 3 and fills the buffer exactly.
    builder.bezierTo(5, 1, 0, 6, 1, 0, 7, 0, 0);
    expect(builder.pointCount).toBe(8);
    expect(builder.points.length).toBe(24);
    builder.bezierTo(8, 1, 0, 9, 1, 0, 10, 0, 0);
    expect(builder.points.length).toBe(48);
    expect(builder.ops.length).toBe(8);
    builder.lineTo(11, 0, 0).lineTo(12, 0, 0);
    expect(builder.opCount).toBe(9);
    expect(builder.ops.length).toBe(16);
    const xs = Array.from({ length: builder.pointCount }, (_, i) => builder.points[i * 3]);
    expect(xs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(builder.ops.subarray(0, builder.opCount))).toEqual([
      PathOp.move,
      PathOp.line,
      PathOp.line,
      PathOp.line,
      PathOp.line,
      PathOp.cubic,
      PathOp.cubic,
      PathOp.line,
      PathOp.line,
    ]);
  });

  it('arcTo after buffer growth takes the correct last point', () => {
    const builder = new PathBuilder();
    for (let i = 0; i < 30; i++) builder.lineTo(i, 0, 0);
    builder.arcTo(29, 16, 0, 45, 16, 0);
    const i = (builder.pointCount - 3) * 3;
    expect(Array.from(builder.points.subarray(i, i + 3))).toEqual([29, 16 * ARC_HANDLE, 0]);
  });

  it('addCommands: a path starting with bezier or arc, and points with missing coordinates', () => {
    const bezier = new PathBuilder().addCommands([
      { type: 'bezier', control1: { x: 9 }, control2: { y: 9 }, point: { z: 4 } },
    ]);
    expect(fromGeometry(bezier).points).toEqual([0, 0, 4]);
    const arc = new PathBuilder().addCommands([
      { type: 'arc', corner: { x: 9 }, point: { y: 2 } },
      { type: 'arc', corner: { y: 1 }, point: {} },
    ]);
    const recorded = fromGeometry(arc);
    expect(recorded.ops).toEqual([PathOp.move, PathOp.cubic]);
    expect(recorded.points.every((value) => Number.isFinite(value))).toBe(true);
    expect(recorded.points.slice(0, 3)).toEqual([0, 2, 0]);
  });

  it('the first command becomes a move to its end point', () => {
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

  it('an arc is a curve with 9/16 handles toward the corner', () => {
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

  it('buffers grow and are reused after reset', () => {
    const builder = new PathBuilder();
    for (let i = 0; i < 100; i++) builder.lineTo(i, 0, 0);
    expect(builder.opCount).toBe(100);
    expect(builder.points[99 * 3]).toBe(99);
    const { ops, points } = builder;
    builder.reset().moveTo(5, 5, 5);
    expect(builder.ops).toBe(ops);
    expect(builder.points).toBe(points);
    expect(fromGeometry(builder).points).toEqual([5, 5, 5]);
  });

  it('finish: two lines close, one does not', () => {
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

describe('lazy geometry', () => {
  it('rebuilds only after a parameter change', () => {
    const ellipse = new Ellipse({ diameter: 10 });
    const version = ellipse.geometryVersion;
    ellipse.geometry;
    ellipse.width = 10;
    ellipse.position.x = 50;
    ellipse.style.color = '#f00';
    expect(ellipse.geometryVersion).toBe(version);
    ellipse.width = 20;
    ellipse.quarters = 2;
    expect(ellipse.geometryVersion).toBe(version + 1);
    expect(fromGeometry(ellipse.geometry).points.slice(3, 6)).toEqual([10 * ARC_HANDLE, -5, 0]);
  });

  it('geometry buffers are reused when a parameter animates', () => {
    const rect = new RoundedRect({ width: 40, height: 20, cornerRadius: 5 });
    const { ops, points } = rect.geometry;
    for (let i = 1; i <= 30; i++) {
      rect.width = 40 + i;
      rect.geometry;
    }
    expect(rect.geometry.ops).toBe(ops);
    expect(rect.geometry.points).toBe(points);
  });

  it('closed changes geometry, style changes only appearance', () => {
    const rect = new Rect();
    expect(rect.geometry.closed).toBe(true);
    const geometry = rect.geometryVersion;
    rect.style.stroke = 4;
    rect.front.z = -1;
    expect(rect.geometryVersion).toBe(geometry);
    rect.closed = false;
    expect(rect.geometry.closed).toBe(false);
    expect(rect.geometryVersion).toBe(geometry + 1);
  });

  it('each style field and front change appearanceVersion by 1, the same value by 0', () => {
    const changes: [string, (shape: PathShape) => void, (shape: PathShape) => void][] = [
      ['stroke', (s) => (s.style.stroke = 4), (s) => (s.style.stroke = 1)],
      ['fill', (s) => (s.style.fill = true), (s) => (s.style.fill = false)],
      ['color', (s) => (s.style.color = '#f00'), (s) => (s.style.color = ['#', '333'].join(''))],
      [
        'backfaceVisible',
        (s) => (s.style.backfaceVisible = false),
        (s) => (s.style.backfaceVisible = true),
      ],
      [
        'backfaceColor',
        (s) => (s.style.backfaceColor = '#000'),
        (s) => (s.style.backfaceColor = null),
      ],
      ['front', (s) => (s.front.z = -1), (s) => (s.front.z = 1)],
    ];
    for (const [name, change, same] of changes) {
      const shape = new PathShape();
      const version = shape.appearanceVersion;
      same(shape);
      expect(shape.appearanceVersion, `${name}: same value`).toBe(version);
      change(shape);
      expect(shape.appearanceVersion, name).toBe(version + 1);
    }
  });

  it('each numeric parameter: same value no rebuild, new value rebuild, invalid value rejected', () => {
    type Case = [string, () => Ellipse | Rect | RoundedRect | Polygon, string, number, number];
    const cases: Case[] = [
      ['Ellipse.width', () => new Ellipse(), 'width', 5, -1],
      ['Ellipse.height', () => new Ellipse(), 'height', 5, Number.NaN],
      ['Ellipse.quarters', () => new Ellipse(), 'quarters', 2, 5],
      ['Rect.width', () => new Rect(), 'width', 5, -1],
      ['Rect.height', () => new Rect(), 'height', 5, Number.POSITIVE_INFINITY],
      ['RoundedRect.width', () => new RoundedRect(), 'width', 5, -1],
      ['RoundedRect.height', () => new RoundedRect(), 'height', 5, -1],
      ['RoundedRect.cornerRadius', () => new RoundedRect(), 'cornerRadius', 0.4, -1],
      ['Polygon.radius', () => new Polygon(), 'radius', 5, -1],
      ['Polygon.sides', () => new Polygon(), 'sides', 6, 2],
    ];
    for (const [label, make, key, next, bad] of cases) {
      const shape = make() as unknown as Record<string, number> & Shape;
      const before = fromGeometry(shape.geometry).points;
      const version = shape.geometryVersion;
      const current = shape[key] as number;
      shape[key] = current;
      expect(shape.geometryVersion, `${label}: same value`).toBe(version);
      expect(() => {
        shape[key] = bad;
      }, label).toThrow(RangeError);
      expect(shape[key], `${label}: value after rejection`).toBe(current);
      expect(shape.geometryVersion, `${label}: version after rejection`).toBe(version);
      shape[key] = next;
      expect(shape.geometryVersion, label).toBe(version + 1);
      expect(fromGeometry(shape.geometry).points, label).not.toEqual(before);
    }
  });

  it('diameter with an invalid value does not change width and height', () => {
    const ellipse = new Ellipse({ width: 4, height: 8 });
    expect(() => {
      ellipse.diameter = -1;
    }).toThrow(RangeError);
    expect([ellipse.width, ellipse.height]).toEqual([4, 8]);
  });

  it('geometry is always the same object', () => {
    const ellipse = new Ellipse();
    const geometry = ellipse.geometry;
    ellipse.width = 9;
    expect(ellipse.geometry).toBe(geometry);
    expect(geometry.points[3]).toBeCloseTo((9 / 2) * ARC_HANDLE, 12);
  });

  it('diameter sets width and height', () => {
    const ellipse = new Ellipse({ width: 4, height: 8 });
    ellipse.diameter = 6;
    expect([ellipse.width, ellipse.height, ellipse.diameter]).toEqual([6, 6, 6]);
  });

  it('PathShape.path copies and freezes the whole path', () => {
    const point = { x: 2, y: 0, z: 0 };
    const path = [
      { type: 'move' as const, point: { x: 1 } },
      { type: 'line' as const, point },
    ];
    const shape = new PathShape({ path });
    expect(Object.isFrozen(shape.path)).toBe(true);
    expect(Object.isFrozen(shape.path[1])).toBe(true);
    const version = shape.geometryVersion;
    point.x = 99;
    path.push({ type: 'line', point: { x: 5, y: 0, z: 0 } });
    shape.closed = !shape.closed;
    expect(fromGeometry(shape.geometry).points).toEqual([1, 0, 0, 2, 0, 0]);
    expect(shape.path[1]).toEqual({ type: 'line', point: { x: 2, y: 0, z: 0 } });
    shape.path = [{ type: 'move', point: { y: 3 } }];
    expect(shape.geometryVersion).toBe(version + 2);
    expect(fromGeometry(shape.geometry).points).toEqual([0, 3, 0]);
    expect(() => {
      shape.path = [];
    }).toThrow(RangeError);
  });
});

describe('parameter validation', () => {
  it('sizes, stroke, quarters and sides', () => {
    const bad = [-1, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of bad) {
      expect(() => new Rect({ width: value })).toThrow(RangeError);
      expect(() => new Ellipse({ diameter: value })).toThrow(RangeError);
      expect(() => new RoundedRect({ cornerRadius: value })).toThrow(RangeError);
      expect(() => new Polygon({ radius: value })).toThrow(RangeError);
      expect(() => new PathShape({ style: { stroke: value } })).toThrow(RangeError);
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

  it('defaults as in Zdog', () => {
    const shape = new PathShape();
    expect({ ...valuesOf(shape.style), closed: shape.closed }).toEqual({
      stroke: 1,
      fill: false,
      color: '#333',
      backfaceVisible: true,
      backfaceColor: null,
      closed: true,
    });
    expect(Ellipse.params.quarters.default).toBe(4);
    expect(Object.keys(RoundedRect.params)).toEqual(['width', 'height', 'cornerRadius']);
    expect(new Ellipse().closed).toBe(false);
    expect(new RoundedRect().closed).toBe(false);
    expect(new Rect().closed).toBe(true);
    expect([new Polygon().sides, new Polygon().radius]).toEqual([3, 0.5]);
  });
});
