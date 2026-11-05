import { euler, quat, vec3 } from '@mascotte/math';
import { zdogFixture } from './zdog-fixture.ts';

const zdog = zdogFixture('camera');

import { describe, expect, it } from 'vitest';
import { Camera, createProjectedPoint, Node, Scene } from '../src/index.ts';

function projected(camera: Camera, point: vec3.Vec3, referenceDepth?: number) {
  const out = createProjectedPoint();
  const visible = camera.project(out, point, referenceDepth);
  return { visible, ...out };
}

describe('Camera: ортография', () => {
  it('по умолчанию: без перспективы, zoom 1, точка не меняется', () => {
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

  it('zoom увеличивает и координаты, и масштаб обводок', () => {
    const camera = new Camera({ zoom: 2 });
    expect(projected(camera, { x: 3, y: -4, z: -1000 })).toMatchObject({ x: 6, y: -8, scale: 2 });
    expect(camera.scaleAt(500)).toBe(2);
    expect(camera.isInFront(1e9)).toBe(true);
  });

  it('сдвиг камеры сдвигает кадр в обратную сторону', () => {
    const camera = new Camera({ position: { x: 10, y: 5, z: 0 } });
    expect(projected(camera, { x: 10, y: 5, z: 0 })).toMatchObject({ x: 0, y: 0 });
    expect(projected(camera, { x: 0, y: 0, z: 0 })).toMatchObject({ x: -10, y: -5 });
  });

  it('поворот камеры вокруг Y на 90° показывает сцену сбоку', () => {
    const camera = new Camera({ rotation: euler.create(0, Math.PI / 2, 0) });
    // Камера смотрит вдоль −z своей системы; после поворота это −x мира.
    const side = projected(camera, { x: -10, y: 0, z: 0 });
    expect(side.x).toBeCloseTo(0, 12);
    expect(side.depth).toBeCloseTo(-10, 12);
    expect(side.y).toBeCloseTo(0, 12);
    const right = projected(camera, { x: 0, y: 3, z: -10 });
    expect(right.x).toBeCloseTo(10, 12);
    expect(right.y).toBeCloseTo(3, 12);
  });
});

describe('Camera: перспектива', () => {
  const camera = new Camera({ projection: 'perspective', distance: 100, zoom: 2 });

  it('на глубине 0 масштаб равен zoom, ближе — крупнее, дальше — мельче', () => {
    expect(camera.scaleAt(0)).toBe(2);
    expect(camera.scaleAt(50)).toBe(4);
    expect(camera.scaleAt(-100)).toBe(1);
  });

  it('точка у плоскости камеры и за ней не видна, out не меняется', () => {
    const out = createProjectedPoint();
    out.x = 123;
    expect(camera.project(out, { x: 1, y: 1, z: 100 })).toBe(false);
    expect(camera.project(out, { x: 1, y: 1, z: 150 })).toBe(false);
    expect(out.x).toBe(123);
    expect(camera.isInFront(99.9)).toBe(true);
  });

  it('слабая перспектива: опорная глубина масштабирует все точки фигуры одинаково', () => {
    const near = projected(camera, { x: 10, y: 0, z: 20 }, 0);
    const far = projected(camera, { x: 10, y: 0, z: -20 }, 0);
    expect(near.x).toBe(20);
    expect(far.x).toBe(20);
    expect(near.depth).toBe(20);
    expect(far.depth).toBe(-20);
    // Без опорной глубины каждая точка масштабируется по своей.
    expect(projected(camera, { x: 10, y: 0, z: 20 }).x).toBeCloseTo(25, 12);
  });

  it('projectView работает с точкой в пространстве камеры', () => {
    const out = createProjectedPoint();
    expect(camera.projectView(out, { x: 1, y: 2, z: 50 })).toBe(true);
    expect(out).toEqual({ x: 4, y: 8, depth: 50, scale: 4 });
  });
});

describe('Camera: параметры и кэш', () => {
  it('zoom и distance проверяются, projectionVersion растёт только при изменении', () => {
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

  it('viewMatrix кэшируется и обновляется при движении камеры или её предка', () => {
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

  it('distance проверяется и в сеттере, zoom — в конструкторе', () => {
    const camera = new Camera({ distance: 200 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        camera.distance = bad;
      }).toThrow(RangeError);
      expect(() => new Camera({ zoom: bad })).toThrow(RangeError);
    }
    expect(camera.distance).toBe(200);
  });

  it('вырожденная камера — ошибка', () => {
    const camera = new Camera({ scale: { x: 0, y: 1, z: 1 } });
    expect(() => camera.viewMatrix).toThrow(/вырождена/);
  });

  it('камеру можно держать в сцене и находить по id', () => {
    const scene = new Scene();
    const camera = new Camera({ id: 'main-camera' });
    scene.root.add(camera);
    expect(scene.getById('main-camera')).toBe(camera);
  });
});

/*
 * В Zdog нет камеры: вращают и масштабируют саму иллюстрацию. Камера с обратным
 * поворотом и тем же zoom должна давать ту же картинку.
 */
describe('совместимость с Zdog', () => {
  it('камера с обратным поворотом = повёрнутая сцена Zdog', () => {
    const rotate = { x: 0.4, y: -0.9, z: 0.3 };
    const zoom = 1.5;
    const points = [
      { x: 10, y: -5, z: 3 },
      { x: -7, y: 2, z: -12 },
      { x: 0, y: 20, z: 6 },
    ];
    const origins = zdog.next<{ x: number; y: number; z: number }[]>('origins');

    const sceneRotation = quat.fromEuler(
      quat.create(),
      euler.create(rotate.x, -rotate.y, rotate.z),
    );
    const camera = new Camera({ zoom });
    camera.rotation.copy(quat.conjugate(quat.create(), sceneRotation));

    points.forEach((point, i) => {
      const origin = origins[i];
      if (!origin) throw new Error('нет точки Zdog');
      const out = projected(camera, point);
      expect(out.x).toBeCloseTo(origin.x * zoom, 9);
      expect(out.y).toBeCloseTo(origin.y * zoom, 9);
      expect(out.depth).toBeCloseTo(origin.z, 9);
    });
  });
});

describe('Camera: перспектива у сдвинутой и повёрнутой камеры', () => {
  it('глубина берётся из пространства камеры, а не из мирового z', () => {
    const camera = new Camera({
      projection: 'perspective',
      distance: 100,
      position: { x: 0, y: 0, z: 50 },
    });
    // В пространстве камеры точка на глубине −50: масштаб 100 / 150.
    const out = projected(camera, { x: 10, y: 0, z: 0 });
    expect(out.depth).toBeCloseTo(-50, 12);
    expect(out.scale).toBeCloseTo(2 / 3, 12);
    expect(out.x).toBeCloseTo(20 / 3, 12);
  });

  it('камера, развёрнутая на 180°, видит мировой +z как −z', () => {
    const camera = new Camera({
      projection: 'perspective',
      distance: 100,
      rotation: euler.create(0, Math.PI, 0),
    });
    const out = projected(camera, { x: 0, y: 0, z: 50 });
    expect(out.depth).toBeCloseTo(-50, 12);
    expect(out.scale).toBeCloseTo(2 / 3, 12);
  });

  it('getEyePosition: глаз на distance позади узла, в ортографии его нет', () => {
    const camera = new Camera({
      projection: 'perspective',
      distance: 100,
      position: { x: 5, y: 0, z: 0 },
      rotation: euler.create(0, Math.PI / 2, 0),
      scale: 3,
    });
    const eye = camera.getEyePosition(vec3.create());
    if (!eye) throw new Error('у перспективной камеры есть глаз');
    // Локальная ось z после поворота на 90° вокруг Y — мировая +x; масштаб не учитывается.
    expect(eye.x).toBeCloseTo(105, 9);
    expect(eye.y).toBeCloseTo(0, 9);
    expect(eye.z).toBeCloseTo(0, 9);
    // Точка в глазу — на границе видимости.
    expect(camera.isInFront(camera.toView(vec3.create(), eye).z)).toBe(false);
    camera.projection = 'orthographic';
    expect(camera.getEyePosition(vec3.create())).toBeNull();
  });

  it('referenceDepth решает видимость, даже если сама точка за глазом', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100, zoom: 2 });
    const out = createProjectedPoint();
    expect(camera.project(out, { x: 1, y: 0, z: 150 }, 0)).toBe(true);
    expect(out).toEqual({ x: 2, y: 0, depth: 150, scale: 2 });
    const untouched = createProjectedPoint();
    expect(camera.project(untouched, { x: 1, y: 0, z: 0 }, 150)).toBe(false);
    expect(untouched).toEqual(createProjectedPoint());
  });

  it('очень далёкая точка видна и почти не имеет размера', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100 });
    const scale = camera.scaleAt(-1e9);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1e-6);
    expect(camera.isInFront(-1e9)).toBe(true);
  });

  it('возврат к ортографии отключает перспективу', () => {
    const camera = new Camera({ projection: 'perspective', distance: 100, zoom: 2 });
    camera.projection = 'orthographic';
    expect(camera.scaleAt(50)).toBe(2);
    expect(camera.isInFront(1e9)).toBe(true);
  });

  it('в ортографии referenceDepth не влияет на масштаб, глубина берётся из точки', () => {
    const camera = new Camera({ zoom: 3 });
    expect(projected(camera, { x: 3, y: 0, z: 7 }, -500)).toMatchObject({
      x: 9,
      depth: 7,
      scale: 3,
    });
  });
});

describe('Camera: масштаб узла не попадает в кадр', () => {
  it('масштаб камеры и предка не меняет картинку', () => {
    const rotation = euler.create(0.3, 0.2, 0.1);
    const plain = new Camera({ position: { x: 1, y: 2, z: 3 }, rotation });
    // Равномерный масштаб предка не меняет ориентацию; позиция (0.5, 1, 1.5) · 2 = (1, 2, 3).
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

  it('при неравномерном масштабе предка круг остаётся кругом', () => {
    const rig = new Node({ scale: { x: 1, y: 4, z: 1 }, rotation: euler.create(0, 0, 0.7) });
    const camera = new Camera();
    rig.add(camera);
    // Точки на окружности радиуса 10 вокруг камеры остаются на расстоянии 10.
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
