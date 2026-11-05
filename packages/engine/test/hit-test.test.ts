import { euler } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  Camera,
  Cone,
  Cylinder,
  Ellipse,
  Hemisphere,
  HitTester,
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

/** Попадание в точку (x, y) относительно центра кадра 100×100. */
function hit(scene: Scene, x: number, y: number, cam = camera) {
  return new HitTester().hitTest(scene, cam, viewport, 50 + x, 50 + y);
}

describe('HitTester', () => {
  it('пустая точка и пустая сцена — null', () => {
    expect(hit(new Scene(), 0, 0)).toBeNull();
    expect(hit(sceneWith(new Sphere({ diameter: 10 })), 30, 30)).toBeNull();
  });

  it('видна ближняя фигура, глубина — передняя точка поверхности', () => {
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

  it('пересекающиеся сферы: каждая видна на своей половине', () => {
    const left = new Sphere({ diameter: 40, position: { x: -6, y: 0, z: 0 } });
    const right = new Sphere({ diameter: 40, position: { x: 6, y: 0, z: 0 } });
    const scene = sceneWith(left, right);
    expect(hit(scene, -2, 0)?.drawable).toBe(left);
    expect(hit(scene, 2, 0)?.drawable).toBe(right);
  });

  it('при равной глубине видна нарисованная раньше', () => {
    const first = new PathShape({ style: { stroke: 10 } });
    const second = new PathShape({ style: { stroke: 10 } });
    expect(hit(sceneWith(first, second), 0, 0)?.drawable).toBe(first);
  });

  it('слой −1 под содержимым, даже если ближе; слой +1 над ним, даже если дальше', () => {
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
    // Вне тела нижний слой виден.
    under.position.x = -30;
    expect(hit(scene, -30, 0)?.drawable).toBe(under);
  });

  it('декаль видна только на опоре, даже лёжа глубже её поверхности; видна последняя', () => {
    const head = new Sphere({ diameter: 40, style: { stroke: 0 } });
    const spot = new PathShape({
      sortMode: 'attached',
      position: { x: 20, y: 0, z: -2 },
      style: { stroke: 10 },
    });
    const pupil = new PathShape({
      sortMode: 'attached',
      // Ближе пятна: декали рисуются по глубине, поэтому зрачок поверх.
      position: { x: 20, y: 0, z: -1 },
      style: { stroke: 4 },
    });
    head.add(spot);
    head.add(pupil);
    const scene = sceneWith(head);
    expect(hit(scene, 17, 0)?.drawable).toBe(spot);
    expect(hit(scene, 19, 0)?.drawable).toBe(pupil);
    // Снаружи силуэта головы декали нет.
    expect(hit(scene, 23, 0)).toBeNull();
  });

  it('декаль закрыта тем, что закрывает опору', () => {
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

  it('у полупрозрачной опоры декаль — обычная фигура и сравнивается по глубине', () => {
    const head = new Sphere({ diameter: 40, opacity: 0.5, style: { stroke: 0 } });
    const inside = new PathShape({
      sortMode: 'attached',
      position: { x: 0, y: 0, z: 10 },
      style: { stroke: 4 },
    });
    head.add(inside);
    expect(hit(sceneWith(head), 0, 0)?.drawable).toBe(head);
  });

  it('часть составной фигуры: узел — сама составная фигура', () => {
    const cylinder = new Cylinder({ diameter: 20, length: 20 });
    const result = hit(sceneWith(cylinder), 0, 0);
    expect(result?.node).toBe(cylinder);
    expect(result?.drawable.owner).toBe(cylinder);
    // Ось вдоль z: видна передняя крышка на z = 10.
    expect(result?.depth).toBeCloseTo(10, 6);
    // Повёрнутый поперёк взгляда цилиндр — видна боковая стенка.
    cylinder.setRotationFromEuler(euler.create(0, Math.PI / 2, 0));
    const side = hit(sceneWith(cylinder), 0, 0);
    expect(side?.drawable.owner).toBe(cylinder);
    expect(side?.depth).toBeCloseTo(10.5, 6);
  });

  it('конус и полусфера: глубина бока конуса и купола', () => {
    // Вершина на z = 20, радиус основания 10: на расстоянии 1 от оси бок на z = 18.
    expect(
      hit(sceneWith(new Cone({ diameter: 20, length: 20, style: { stroke: 0 } })), 1, 0)?.depth,
    ).toBeCloseTo(18, 6);
    expect(hit(sceneWith(new Hemisphere({ diameter: 20 })), 0, 0)?.depth).toBeCloseTo(10.5, 6);
  });

  it('скрытое, невидимое и обратная сторона без backfaceVisible не попадают', () => {
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

  it('заливка, обводка и кривые', () => {
    const scene = sceneWith(
      new Rect({ width: 20, height: 20, style: { fill: true, stroke: 2 } }),
      new Ellipse({ diameter: 60, position: { x: 0, y: 0, z: -10 }, style: { stroke: 4 } }),
    );
    expect(hit(scene, 0, 0)?.drawable).toBeInstanceOf(Rect);
    // Обводка выступает за край заливки на полтолщины.
    expect(hit(scene, 10.8, 0)?.drawable).toBeInstanceOf(Rect);
    // Кольцо без заливки: попадание только по обводке.
    expect(hit(scene, 30, 0)?.drawable).toBeInstanceOf(Ellipse);
    expect(hit(scene, 0, -30)?.drawable).toBeInstanceOf(Ellipse);
    expect(hit(scene, 20, 0)).toBeNull();
  });

  it('перспектива и масштаб камеры учитываются', () => {
    const sphere = new Sphere({ diameter: 10, position: { x: 20, y: 0, z: 0 } });
    expect(hit(sceneWith(sphere), 40, 0, new Camera({ zoom: 2 }))?.drawable).toBe(sphere);
    const perspective = new Camera({ projection: 'perspective', distance: 100 });
    sphere.position.z = 50;
    // На глубине 50 при расстоянии 100 масштаб 2: центр шара на экране в x = 40.
    expect(hit(sceneWith(sphere), 40, 0, perspective)?.drawable).toBe(sphere);
    expect(hit(sceneWith(sphere), 20, 0, perspective)).toBeNull();
  });
});
