import { describe, expect, it } from 'vitest';
import { ScreenOp, ScreenPath } from '../src/index.ts';
import { ParamStore } from '../src/shapes/params.ts';

describe('ScreenPath', () => {
  it('раскладка чисел у каждой операции', () => {
    const path = new ScreenPath()
      .moveTo(1, 2)
      .lineTo(3, 4)
      .cubicTo(5, 6, 7, 8, 9, 10)
      .arc(11, 12, 13, 14, 15, true);
    expect(Array.from(path.ops.subarray(0, path.opCount))).toEqual([
      ScreenOp.move,
      ScreenOp.line,
      ScreenOp.cubic,
      ScreenOp.arc,
    ]);
    expect(Array.from(path.data.subarray(0, path.dataCount))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1,
    ]);
    expect(path.closed).toBe(false);
    expect(path.close().closed).toBe(true);
  });

  it('рост буферов сохраняет данные, reset не пересоздаёт их', () => {
    const path = new ScreenPath();
    for (let i = 0; i < 100; i++) path.lineTo(i, -i);
    expect(path.opCount).toBe(100);
    expect(path.data[198]).toBe(99);
    expect(path.data[199]).toBe(-99);
    const { ops, data } = path;
    path.close().reset().moveTo(5, 6);
    expect([path.opCount, path.dataCount, path.closed]).toEqual([1, 2, false]);
    expect(path.ops).toBe(ops);
    expect(path.data).toBe(data);
  });
});

describe('ParamStore', () => {
  const schema = {
    size: { kind: 'length', default: 1 },
    count: { kind: 'integer', default: 3, min: 1, max: 5 },
  } as const;

  it('значения по умолчанию, ввод из options, изменение и отказ', () => {
    let changes = 0;
    const store = new ParamStore(schema, { size: 4 }, () => changes++);
    expect([store.get('size'), store.get('count')]).toEqual([4, 3]);
    store.set('count', 3);
    expect(changes).toBe(0);
    store.set('count', 5);
    expect(changes).toBe(1);
    expect(() => store.set('count', 6)).toThrow(RangeError);
    expect(() => store.set('size', -1)).toThrow(RangeError);
    expect([store.get('size'), store.get('count'), changes]).toEqual([4, 5, 1]);
    expect(() => new ParamStore(schema, { count: 0 }, () => {})).toThrow(RangeError);
  });
});
