import { euler, quat, type Vec3, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.ts';
import { Node, Scene } from '../src/index.ts';

function expectVec(actual: Readonly<Vec3>, expected: Readonly<Vec3>, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

const world = (node: Node) => node.getWorldPosition(vec3.create());

describe('служебный доступ закрыт', () => {
  it('пакет не экспортирует внутренние объекты, у Scene и Node нет служебных методов', () => {
    expect(Object.keys(engine).sort()).toEqual(
      [
        'ARC_HANDLE',
        'AUTO_ID_PREFIX',
        'Camera',
        'createProjectedPoint',
        'Ellipse',
        'Node',
        'ObservedQuat',
        'ObservedVec3',
        'PathBuilder',
        'PathOp',
        'PathShape',
        'Polygon',
        'Rect',
        'RoundedRect',
        'Scene',
        'Shape',
        'ShapeStyle',
        'BOX_FACES',
        'Box',
        'Capsule',
        'Cone',
        'ConeSurface',
        'Cylinder',
        'CylinderBody',
        'Hemisphere',
        'HemisphereDome',
        'ScreenOp',
        'ScreenPath',
        'Solid',
        'Sphere',
        'Surface',
        'SurfaceOutline',
        'OWNER_SEPARATOR',
        'Styled',
        'DepthSorter',
        'getSortSettingsVersion',
        'isDrawable',
        'CanvasRenderer',
        'DisplayItem',
        'DisplayList',
        'Bucket',
        'decalAnchor',
        'GLCollector',
        'HitTester',
        'IndexBuffer',
        'MAX_ANCHORS',
        'PIXEL_BUDGET',
        'supersampleFor',
        'PRIMITIVE_KINDS',
        'STRIDE',
        'triangulate',
        'WebGLRenderer',
        'splitPath',
        'cutValue',
      ].sort(),
    );
    const scene = new Scene();
    for (const name of ['attachSubtree', 'detachSubtree', 'markStructureChanged']) {
      expect(name in scene, name).toBe(false);
    }
    for (const name of ['attachRoot', 'detachRoot']) {
      expect(name in Node, name).toBe(false);
    }
  });
});

describe('идентификаторы', () => {
  it('пустые, из пробелов и с зарезервированным префиксом запрещены', () => {
    for (const id of ['', '   ', '~1', '~root']) {
      expect(() => new Node({ id }), JSON.stringify(id)).toThrow(RangeError);
    }
    expect(new Node().id.startsWith(engine.AUTO_ID_PREFIX)).toBe(true);
  });
});

describe('внешний вид', () => {
  it('visible и opacity меняют appearanceVersion, opacity обрезается, NaN запрещён', () => {
    const node = new Node();
    const version = node.appearanceVersion;
    node.visible = true;
    node.opacity = 1;
    expect(node.appearanceVersion).toBe(version);
    node.visible = false;
    node.opacity = 0.5;
    expect(node.appearanceVersion).toBe(version + 2);
    node.opacity = 2;
    expect(node.opacity).toBe(1);
    node.opacity = -1;
    expect(node.opacity).toBe(0);
    expect(() => {
      node.opacity = Number.NaN;
    }).toThrow(RangeError);
    expect(() => new Node({ opacity: Number.NaN })).toThrow(RangeError);
    expect(new Node({ opacity: 3 }).opacity).toBe(1);
  });

  it('worldOpacity с нулём и видимость отсоединённого узла', () => {
    const parent = new Node({ opacity: 0 });
    const child = new Node();
    parent.add(child);
    expect(child.worldOpacity).toBe(0);
    child.removeFromParent();
    expect(child.worldOpacity).toBe(1);
    expect(child.visibleInTree).toBe(true);
  });
});

describe('трансформации в иерархии', () => {
  it('каждая компонента трансформации помечает узел', () => {
    const fields: [string, (node: Node) => void][] = [
      ['position.x', (n) => (n.position.x = 1)],
      ['position.y', (n) => (n.position.y = 1)],
      ['position.z', (n) => (n.position.z = 1)],
      ['scale.x', (n) => (n.scale.x = 2)],
      ['scale.y', (n) => (n.scale.y = 2)],
      ['scale.z', (n) => (n.scale.z = 2)],
      ['pivot.x', (n) => (n.pivot.x = 1)],
      ['pivot.y', (n) => (n.pivot.y = 1)],
      ['pivot.z', (n) => (n.pivot.z = 1)],
      ['pivot.copy', (n) => n.pivot.copy({ x: 1, y: 2, z: 3 })],
      ['rotation.x', (n) => (n.rotation.x = 0.1)],
      ['rotation.y', (n) => (n.rotation.y = 0.1)],
      ['rotation.z', (n) => (n.rotation.z = 0.1)],
      ['rotation.w', (n) => (n.rotation.w = 0.9)],
    ];
    for (const [name, change] of fields) {
      const node = new Node();
      const version = node.worldVersion;
      change(node);
      expect(node.worldVersion, name).toBe(version + 1);
    }
  });

  it('pivot родителя: поворот на 90° вокруг его точки', () => {
    const parent = new Node({
      pivot: { x: 1, y: 0, z: 0 },
      rotation: euler.create(0, 0, Math.PI / 2),
    });
    const child = new Node({ position: { x: 2, y: 0, z: 0 } });
    parent.add(child);
    // Точка (2, 0, 0) поворачивается вокруг (1, 0, 0) на 90° против часовой: (1, 1, 0).
    expectVec(world(child), { x: 1, y: 1, z: 0 });
  });

  it('поддерево, посчитанное отдельно, после подключения учитывает нового родителя', () => {
    for (const parentDirty of [true, false]) {
      const scene = new Scene(new Node({ position: { x: 100, y: 0, z: 0 } }));
      if (!parentDirty) scene.root.worldMatrix;
      const a = new Node({ position: { x: 1, y: 0, z: 0 } });
      const b = new Node({ position: { x: 0, y: 2, z: 0 } });
      const c = new Node({ position: { x: 0, y: 0, z: 3 } });
      a.add(b);
      b.add(c);
      expectVec(world(c), { x: 1, y: 2, z: 3 });
      scene.root.add(a);
      expectVec(world(c), { x: 101, y: 2, z: 3 });
    }
  });

  it('перестановка внутри родителя не пересчитывает мировую матрицу', () => {
    const parent = new Node();
    const [x, y] = [new Node(), new Node()];
    parent.add(x).add(y);
    const version = x.worldVersion;
    parent.add(x, 1);
    expect(parent.children).toEqual([y, x]);
    expect(x.worldVersion).toBe(version);
  });

  it('remove помечает мировую матрицу ребёнка', () => {
    const parent = new Node({ position: { x: 5, y: 0, z: 0 } });
    const child = new Node();
    parent.add(child);
    const version = child.worldVersion;
    parent.remove(child);
    expect(child.worldVersion).toBe(version + 1);
  });

  it('onWorldInvalidated вызывается один раз на каждую пометку', () => {
    class Counting extends Node {
      calls = 0;
      protected override onWorldInvalidated(): void {
        this.calls++;
      }
    }
    const parent = new Node();
    const child = new Counting();
    parent.add(child);
    child.worldMatrix;
    const before = child.calls;
    parent.position.x = 1;
    parent.position.y = 1;
    expect(child.calls).toBe(before + 1);
    child.worldMatrix;
    parent.rotation.copy(quat.setAxisAngle(quat.create(), { x: 0, y: 0, z: 1 }, 1));
    expect(child.calls).toBe(before + 2);
  });
});

describe('дети и обход', () => {
  it('children — неизменяемый снимок, обновляется при изменении состава', () => {
    const parent = new Node();
    const [a, b, c] = [new Node(), new Node(), new Node()];
    parent.add(a).add(b).add(c);
    const snapshot = parent.children;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(parent.children).toBe(snapshot);
    for (const child of parent.children) child.removeFromParent();
    expect(parent.children).toEqual([]);
    expect(snapshot).toEqual([a, b, c]);
  });

  it('граничные индексы перестановки', () => {
    const parent = new Node();
    const [a, b, c] = [new Node(), new Node(), new Node()];
    parent.add(a).add(b).add(c);
    parent.add(c, 3);
    expect(parent.children).toEqual([a, b, c]);
    parent.add(b, 1);
    expect(parent.children).toEqual([a, b, c]);
    parent.add(a, 2);
    expect(parent.children).toEqual([b, c, a]);
  });

  it('traverse останавливается во внуке и пропускает соседей предков', () => {
    const root = new Node({ id: 'r' });
    const a = new Node({ id: 'a' });
    const deep = new Node({ id: 'deep' });
    const sibling = new Node({ id: 'sibling' });
    root.add(a).add(sibling);
    a.add(deep);
    const seen: string[] = [];
    const stopped = root.traverse((node) => {
      seen.push(node.id);
      return node.id !== 'deep';
    });
    expect(stopped).toBe(deep);
    expect(seen).toEqual(['r', 'a', 'deep']);
    expect(root.traverse(() => true)).toBeNull();
  });
});

describe('сцена: структура и индекс', () => {
  it('structureVersion растёт на 1 за каждую операцию', () => {
    const first = new Scene();
    const second = new Scene();
    const [a, b] = [new Node(), new Node()];
    const step = (action: () => void) => {
      const v1 = first.structureVersion;
      action();
      return first.structureVersion - v1;
    };
    expect(step(() => first.root.add(a))).toBe(1);
    expect(step(() => first.root.add(b))).toBe(1);
    expect(step(() => first.root.add(a, 1))).toBe(1);
    expect(step(() => first.root.remove(new Node()))).toBe(0);
    expect(step(() => first.root.remove(b))).toBe(1);
    const v2 = second.structureVersion;
    expect(step(() => second.root.add(a))).toBe(1);
    expect(second.structureVersion).toBe(v2 + 1);
  });

  it('готовый корень с детьми регистрирует их id, дубликаты отклоняются', () => {
    const root = new Node({ id: 'r' });
    const kid = new Node({ id: 'k' });
    root.add(kid);
    const scene = new Scene(root);
    expect(scene.getById('k')).toBe(kid);
    expect(kid.scene).toBe(scene);

    const broken = new Node({ id: 'b' });
    broken.add(new Node({ id: 'same' })).add(new Node({ id: 'same' }));
    expect(() => new Scene(broken)).toThrow(/same/);
    expect(broken.scene).toBeNull();
  });

  it('перенос в сцену с занятым id отклоняется, узел остаётся в старой', () => {
    const first = new Scene();
    const second = new Scene();
    const a = new Node({ id: 'a' });
    first.root.add(a);
    second.root.add(new Node({ id: 'a' }));
    expect(() => second.root.add(a)).toThrow(/«a»/);
    expect(first.getById('a')).toBe(a);
    expect(a.scene).toBe(first);
    expect(a.parent).toBe(first.root);
  });

  it('уничтожение узла в середине дерева', () => {
    const scene = new Scene();
    const a = new Node({ id: 'a' });
    const b = new Node({ id: 'b' });
    const c = new Node({ id: 'c' });
    scene.root.add(a);
    a.add(b);
    b.add(c);
    expect(scene.nodes).toHaveLength(4);
    b.destroy();
    expect(a.destroyed).toBe(false);
    expect(a.children).toEqual([]);
    expect(scene.getById('b')).toBeNull();
    expect(scene.getById('c')).toBeNull();
    expect(scene.nodes.map((node) => node.id)).toEqual([scene.root.id, 'a']);
  });

  it('destroy корня уничтожает всю сцену', () => {
    const scene = new Scene();
    const a = new Node({ id: 'a' });
    scene.root.add(a);
    scene.root.destroy();
    expect(scene.destroyed).toBe(true);
    expect(scene.root.destroyed).toBe(true);
    expect(a.destroyed).toBe(true);
    expect(scene.getById('a')).toBeNull();
    expect(scene.nodes).toEqual([]);
    expect(a.scene).toBeNull();
  });
});

describe('typeName', () => {
  it('у каждого конкретного класса узла имя типа совпадает с именем класса', async () => {
    const engine: Record<string, unknown> = await import('../src/index.ts');
    const abstract = new Set(['Shape', 'Styled', 'Surface', 'Solid']);
    const checked: string[] = [];
    for (const [name, value] of Object.entries(engine)) {
      if (typeof value !== 'function') continue;
      if (value !== Node && !(value.prototype instanceof Node)) continue;
      if (abstract.has(name)) {
        expect(Object.hasOwn(value, 'typeName'), name).toBe(false);
        continue;
      }
      expect(Object.hasOwn(value, 'typeName'), name).toBe(true);
      expect((value as typeof Node).typeName, name).toBe(name);
      checked.push(name);
    }
    expect(checked.length).toBeGreaterThan(15);
    expect(new Node().typeName).toBe('Node');
  });
});

describe('Scene.changeVersion', () => {
  it('растёт при любом изменении сцены и не растёт от чтения', async () => {
    const engine = await import('../src/index.ts');
    const { PathShape: Path, Sphere: Ball } = engine;
    const scene = new Scene();
    const ball = new Ball({ diameter: 10 });
    const path = new Path({ style: { stroke: 2 } });
    const rect = new engine.Rect({ width: 10, height: 10 });
    const rounded = new engine.RoundedRect({ width: 10, height: 10 });
    const ellipse = new engine.Ellipse({ diameter: 10 });
    const polygon = new engine.Polygon({ radius: 10, sides: 5 });
    const box = new engine.Box({ width: 10, height: 10, depth: 10 });
    scene.root.add(ball);
    for (const node of [rect, rounded, ellipse, polygon, box]) scene.root.add(node);
    let version = scene.changeVersion;
    const changed = (name: string, change: () => void) => {
      change();
      expect(scene.changeVersion, name).toBeGreaterThan(version);
      version = scene.changeVersion;
    };
    changed('добавление', () => scene.root.add(path));
    changed('позиция', () => {
      ball.position.x = 5;
    });
    changed('поворот', () => ball.setRotationFromEuler({ x: 0.3, y: 0, z: 0, order: 'XYZ' }));
    changed('масштаб', () => {
      ball.scale.y = 2;
    });
    changed('видимость', () => {
      ball.visible = false;
    });
    changed('непрозрачность', () => {
      ball.opacity = 0.5;
    });
    changed('стиль', () => {
      ball.style.color = '#123456';
    });
    changed('параметр', () => {
      ball.diameter = 20;
    });
    // Геометрия фигур с путём: она не входит в appearanceVersion, но кадр меняет.
    changed('путь', () => {
      path.path = [
        { type: 'move', point: { x: 0 } },
        { type: 'line', point: { x: 5 } },
      ];
    });
    changed('замкнутость', () => {
      path.closed = !path.closed;
    });
    changed('ширина прямоугольника', () => {
      rect.width = 20;
    });
    changed('скругление', () => {
      rounded.cornerRadius = 3;
    });
    changed('диаметр эллипса', () => {
      ellipse.diameter = 20;
    });
    changed('четверти эллипса', () => {
      ellipse.quarters = 2;
    });
    changed('стороны многоугольника', () => {
      polygon.sides = 7;
    });
    changed('лицевая сторона', () => {
      rect.front.x = 1;
    });
    changed('цвет обратной стороны', () => {
      rect.style.backfaceColor = '#ff0000';
    });
    changed('грань коробки', () => box.setFace('top', { visible: false }));
    changed('опорная точка', () => {
      ball.pivot.x = 2;
    });
    changed('режим сортировки', () => {
      path.sortMode = 'layer';
    });
    changed('слой', () => {
      path.layer = 2;
    });
    changed('смещение глубины', () => {
      path.zBias = 3;
    });
    changed('удаление', () => scene.root.remove(path));

    // Чтение матриц, видимости и непрозрачности ничего не меняет; то же значение — тоже.
    ball.worldMatrix;
    ball.visibleInTree;
    ball.worldOpacity;
    ball.position.x = 5;
    ball.opacity = 0.5;
    expect(scene.changeVersion).toBe(version);
    // Узел вне сцены сцену не трогает.
    path.position.x = 9;
    expect(scene.changeVersion).toBe(version);
  });
});
