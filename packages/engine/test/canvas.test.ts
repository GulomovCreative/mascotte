import { euler } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  CanvasRenderer,
  type CanvasTarget,
  Cylinder,
  DisplayList,
  Node,
  PathShape,
  Rect,
  Scene,
  ScreenOp,
  Sphere,
} from '../src/index.ts';

const camera = new Camera();

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

function items(list: DisplayList) {
  return Array.from({ length: list.count }, (_, i) => list.item(i));
}

describe('DisplayList', () => {
  it('фигура проецируется в пиксели с учётом zoom, точка — круг из обводки', () => {
    const rect = new Rect({
      width: 10,
      height: 4,
      position: { x: 5, y: 0, z: 0 },
      style: { stroke: 2 },
    });
    const dot = new PathShape({
      position: { x: -3, y: 1, z: 0 },
      style: { stroke: 6, color: '#f00' },
    });
    const list = new DisplayList().build(sceneWith(rect, dot), new Camera({ zoom: 2 }));
    const [a, b] = items(list);
    if (!a || !b) throw new Error('должно быть два элемента');
    expect(Array.from(a.path.data.subarray(0, a.path.dataCount))).toEqual([
      0, -4, 20, -4, 20, 4, 0, 4,
    ]);
    expect([a.path.closed, a.lineWidth, a.hasStroke, a.hasFill]).toEqual([true, 4, true, false]);
    expect(b.path.ops[0]).toBe(ScreenOp.arc);
    expect(Array.from(b.path.data.subarray(0, 3))).toEqual([-6, 2, 6]);
    expect([b.hasStroke, b.hasFill, b.color]).toEqual([false, true, '#f00']);
  });

  it('обратная сторона: скрыта, своего цвета или того же', () => {
    const turned = euler.create(0, Math.PI, 0);
    const hidden = new Rect({ id: 'hidden', rotation: turned, style: { backfaceVisible: false } });
    const colored = new Rect({
      id: 'colored',
      rotation: turned,
      style: { color: '#111', backfaceColor: '#abc' },
    });
    const same = new Rect({ id: 'same', rotation: turned, style: { color: '#222' } });
    const front = new Rect({ id: 'front', style: { color: '#333', backfaceColor: '#abc' } });
    const list = new DisplayList().build(sceneWith(hidden, colored, same, front), camera);
    expect(items(list).map((item) => [item.node?.id, item.color])).toEqual([
      ['colored', '#abc'],
      ['same', '#222'],
      ['front', '#333'],
    ]);
  });

  it('прозрачность с учётом предков; полностью прозрачное и скрытое не попадает', () => {
    const parent = new Node({ opacity: 0.5 });
    parent.add(new Rect({ id: 'half', opacity: 0.5 }));
    const list = new DisplayList().build(
      sceneWith(
        parent,
        new Rect({ id: 'gone', opacity: 0 }),
        new Rect({ id: 'off', visible: false }),
      ),
      camera,
    );
    expect(items(list).map((item) => [item.node?.id, item.opacity])).toEqual([['half', 0.25]]);
  });

  it('без обводки и заливки элемент не попадает, точка без обводки — тоже', () => {
    const list = new DisplayList().build(
      sceneWith(
        new Rect({ style: { stroke: 0, fill: false } }),
        new PathShape({ style: { stroke: 0 } }),
      ),
      camera,
    );
    expect(list.count).toBe(0);
  });

  it('обводка масштабируется вместе с узлом', () => {
    const list = new DisplayList().build(
      sceneWith(new Rect({ scale: 3, style: { stroke: 2 } })),
      camera,
    );
    expect(list.item(0).lineWidth).toBeCloseTo(6, 12);
  });

  it('части составной фигуры в перспективе берут глубину владельца', () => {
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    const cylinder = new Cylinder({
      length: 40,
      diameter: 10,
      position: { x: 0, y: 0, z: 20 },
      style: { stroke: 0 },
    });
    const list = new DisplayList().build(sceneWith(cylinder), perspective);
    const scale = perspective.scaleAt(20);
    for (const item of items(list)) {
      if (item.node === cylinder.body) continue;
      // Основание в плоскости, перпендикулярной взгляду: радиус = 5 · масштаб глубины цилиндра.
      const data = Array.from(item.path.data.subarray(0, item.path.dataCount));
      const ys = data.filter((_, i) => i % 2 === 1);
      expect(Math.max(...ys)).toBeCloseTo(5 * scale, 9);
    }
  });

  it('за глазом камеры фигура не рисуется', () => {
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    const list = new DisplayList().build(
      sceneWith(new Rect({ position: { x: 0, y: 0, z: 150 } })),
      perspective,
    );
    expect(list.count).toBe(0);
  });

  it('элементы и буферы переиспользуются между кадрами', () => {
    const scene = sceneWith(new Rect(), new Sphere(), new Cylinder());
    const list = new DisplayList();
    list.build(scene, camera);
    const first = items(list);
    const buffers = first.map((item) => item.path.data);
    list.build(scene, camera);
    const second = items(list);
    second.forEach((item, i) => {
      expect(item).toBe(first[i]);
      expect(item.path.data).toBe(buffers[i]);
    });
    expect(() => list.item(list.count)).toThrow(RangeError);
  });
});

/** Контекст, который записывает вызовы и присваивания. */
function recordingContext() {
  const calls: string[] = [];
  const target = {
    beginPath: () => calls.push('beginPath'),
    moveTo: (x: number, y: number) => calls.push(`moveTo ${x} ${y}`),
    lineTo: (x: number, y: number) => calls.push(`lineTo ${x} ${y}`),
    bezierCurveTo: () => calls.push('bezierCurveTo'),
    arc: (x: number, y: number, r: number) => calls.push(`arc ${x} ${y} ${r}`),
    closePath: () => calls.push('closePath'),
    stroke: () => calls.push('stroke'),
    fill: () => calls.push('fill'),
    setTransform: (...args: number[]) => calls.push(`setTransform ${args.join(' ')}`),
    clearRect: () => calls.push('clearRect'),
    fillRect: () => calls.push('fillRect'),
  };
  for (const key of [
    'strokeStyle',
    'fillStyle',
    'lineWidth',
    'lineCap',
    'lineJoin',
    'globalAlpha',
  ]) {
    Object.defineProperty(target, key, {
      set(value: unknown) {
        calls.push(`${key}=${value}`);
      },
    });
  }
  return { ctx: target as unknown as CanvasTarget, calls };
}

describe('CanvasRenderer', () => {
  it('центр кадра и devicePixelRatio, фон или очистка', () => {
    const { ctx, calls } = recordingContext();
    new CanvasRenderer().render(ctx, sceneWith(), camera, {
      width: 100,
      height: 50,
      pixelRatio: 2,
      background: '#fff',
    });
    expect(calls).toEqual([
      'setTransform 1 0 0 1 0 0',
      'fillStyle=#fff',
      'fillRect',
      'setTransform 2 0 0 2 100 50',
      'lineJoin=round',
      'globalAlpha=1',
    ]);
    const clear = recordingContext();
    new CanvasRenderer().render(clear.ctx, sceneWith(), camera, { width: 10, height: 10 });
    expect(clear.calls).toContain('clearRect');
  });

  it('состояние контекста переключается только при изменении', () => {
    const { ctx, calls } = recordingContext();
    const shapes = [0, 1, 2].map(
      (i) =>
        new Rect({
          position: { x: i * 20, y: 0, z: i },
          style: { stroke: 2, fill: true, color: '#123' },
        }),
    );
    new CanvasRenderer().render(ctx, sceneWith(...shapes), camera, { width: 100, height: 100 });
    const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
    expect(count('strokeStyle=')).toBe(1);
    expect(count('fillStyle=')).toBe(1);
    expect(count('lineWidth=')).toBe(1);
    expect(count('lineCap=')).toBe(1);
    expect(count('stroke')).toBe(3 + 1);
    expect(count('fill')).toBe(3 + 1);
    expect(count('closePath')).toBe(3);
  });

  it('бок цилиндра рисуется с плоскими концами, потом снова круглые', () => {
    const { ctx, calls } = recordingContext();
    new CanvasRenderer().render(
      ctx,
      sceneWith(
        new Cylinder({ rotation: euler.create(0, 1, 0) }),
        new PathShape({
          position: { x: 0, y: 0, z: 50 },
          path: [
            { type: 'move', point: {} },
            { type: 'line', point: { x: 5 } },
          ],
        }),
      ),
      camera,
      { width: 100, height: 100 },
    );
    const caps = calls.filter((c) => c.startsWith('lineCap='));
    expect(caps).toEqual(['lineCap=butt', 'lineCap=round']);
  });
});
