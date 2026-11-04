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

/** Точки совпадают с ожидаемыми с точностью до `digits` знаков (шов ищется делением пополам). */
function expectPoints(actual: number[][], expected: number[][], digits = 9): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, i) => {
    point.forEach((value, k) => {
      expect(value, `точка ${i}, координата ${k}`).toBeCloseTo(
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
  it('плоскость и передняя поверхность сферы', () => {
    expect(cutValue(plane(5), 0, 0, 4)).toBeLessThan(0);
    expect(cutValue(plane(5), 0, 0, 6)).toBeGreaterThan(0);
    // Вне силуэта сфера ничего не закрывает, даже позади центра.
    expect(cutValue(sphere(10), 20, 0, -100)).toBeGreaterThan(0);
    // В центре силуэта передняя поверхность на глубине радиуса.
    expect(cutValue(sphere(10), 0, 0, 9)).toBeLessThan(0);
    expect(cutValue(sphere(10), 0, 0, 11)).toBeGreaterThan(0);
    // У края силуэта поверхность ближе к центральной плоскости: sqrt(100 − 64) = 6.
    expect(cutValue(sphere(10), 8, 0, 5.9)).toBeLessThan(0);
    expect(cutValue(sphere(10), 8, 0, 6.1)).toBeGreaterThan(0);
  });
});

describe('splitPath', () => {
  it('отрезок через плоскость: точка разреза на плоскости, части стыкуются', () => {
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

  it('кривая через плоскость: шов на плоскости, концы на месте', () => {
    const path = new ScreenPath().moveTo(0, 0, -10).cubicTo(10, 20, 20, 20, 30, 0, -10, 10, 10);
    const { back, front } = split(path, plane(0));
    const b = points(back);
    const f = points(front);
    expect(b[0]).toEqual([0, 0, -10]);
    expect(f.at(-1)).toEqual([30, 0, 10]);
    expect(b.at(-1)?.[2]).toBeCloseTo(0, 9);
    expect(f[0]).toEqual(b.at(-1));
    // Симметричная кривая пересекает плоскость посередине.
    expect(b.at(-1)?.[0]).toBeCloseTo(15, 6);
    expect(back.ops[1]).toBe(ScreenOp.cubic);
    expect(front.ops[1]).toBe(ScreenOp.cubic);
  });

  it('замыкающий отрезок замкнутого пути тоже режется', () => {
    const path = new ScreenPath().moveTo(0, 0, -5).lineTo(10, 0, -5).lineTo(10, 10, 5).close();
    const { back, front } = split(path, plane(0));
    // За плоскостью два куска: начало пути до середины второго отрезка и конец замыкающего.
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

  it('без пересечения всё уходит в одну часть', () => {
    const { back, front } = split(new ScreenPath().moveTo(0, 0, 1).lineTo(5, 5, 3), plane(0));
    expect(back.opCount).toBe(0);
    expect(points(front)).toEqual([
      [0, 0, 1],
      [5, 5, 3],
    ]);
  });

  it('сфера: отрезок, проходящий сквозь шар, скрыт внутри силуэта до передней поверхности', () => {
    // От точки за шаром слева к точке перед шаром справа.
    const path = new ScreenPath().moveTo(-20, 0, -20).lineTo(20, 0, 20);
    const { back, front } = split(path, sphere(10));
    const f = points(front);
    // Вне силуэта слева сфера ничего не закрывает: первая передняя часть — до края силуэта.
    expectPoints(
      f.slice(0, 2),
      [
        [-20, 0, -20],
        [-10, 0, -10],
      ],
      6,
    );
    // Шов на передней поверхности: z = sqrt(100 − x²) при x = z, то есть x = sqrt(50).
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

describe('частичное перекрытие в списке отрисовки', () => {
  const camera = new Camera();

  it('ухо из головы: часть за головой рисуется до неё, остальное — после', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    head.add(ear({ x: 10, y: -10, z: -20 }, { x: 20, y: -60, z: 10 }));
    const list = new DisplayList().build(sceneWith(head), camera);
    expect(order(list)).toEqual(['ear', 'head', 'ear']);
    // Ухо до самого края силуэта остаётся позади передней поверхности. Сфера при разрезе
    // раздута на полтолщины уха (5), поэтому шов — на расстоянии 45 от центра на экране.
    const [x = 0, y = 0] = points(list.item(2).path)[0] ?? [];
    expect(Math.hypot(x, y)).toBeCloseTo(45, 6);
  });

  it('обводка целиком за головой, но позже по дереву, переносится до неё', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    head.add(ear({ x: -10, y: 0, z: -30 }, { x: 10, y: 0, z: -30 }));
    const list = new DisplayList().build(sceneWith(head), camera);
    expect(order(list)).toEqual(['ear', 'head']);
  });

  it('не пересекается на экране — не режется и лишних частей нет', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 20 } });
    const far = ear({ x: 100, y: 0, z: -30 }, { x: 120, y: 0, z: 30 });
    const list = new DisplayList().build(sceneWith(head, far), camera);
    expect(order(list)).toEqual(['head', 'ear']);
  });

  it('заливка не режется, выключатель отключает разрез', () => {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    head.add(
      new Rect({
        id: 'filled',
        width: 20,
        height: 20,
        // Перед центром головы, но пересекает её: с заливкой не режется и остаётся одним элементом.
        position: { x: 0, y: 0, z: 10 },
        rotation: euler.create(0, 1.2, 0),
        style: { fill: true },
      }),
    );
    expect(order(new DisplayList().build(sceneWith(head), camera))).toEqual(['head', 'filled']);

    const other = new PathShape({ id: 'head', style: { stroke: 80 } });
    other.add(ear({ x: 10, y: -10, z: -20 }, { x: 20, y: -60, z: 10 }));
    // Без разреза ухо целиком сортируется по глубине центра (за головой) и не делится.
    expect(
      order(new DisplayList({ partialOcclusion: false }).build(sceneWith(other), camera)),
    ).toEqual(['ear', 'head']);
    expect(order(new DisplayList().build(sceneWith(other), camera))).toEqual([
      'ear',
      'head',
      'ear',
    ]);
  });

  it('капсула режется большей сферой; к разрезанной капсуле ничего не крепится', () => {
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
    // Палец режется о тело, а не о разрезанную руку: он стоит вокруг тела.
    expect(ids.indexOf('ear')).toBeLessThan(ids.indexOf('body'));
  });

  it('части переиспользуются между кадрами', () => {
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

describe('декали на сфере', () => {
  const camera = new Camera();

  function face() {
    const head = new PathShape({ id: 'head', style: { stroke: 80 } });
    // Рот лежит внутри сферы головы (z = 38 при радиусе 40), как в Zdog-маскоте.
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

  it('опора не режет декаль, декаль обрезается по силуэту опоры', () => {
    const { scene } = face();
    const list = new DisplayList().build(scene, camera);
    // Декали сортируются между собой по глубине: рот (z = 38) ближе глаза (z = 36).
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

  it('обычный ребёнок внутри сферы закрыт ей, а не обрезан', () => {
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

  it('без частичного перекрытия декали не обрезаются', () => {
    const { scene } = face();
    const list = new DisplayList({ partialOcclusion: false }).build(scene, camera);
    for (let i = 0; i < list.count; i++) expect(list.item(i).clip).toBe('none');
  });
});
