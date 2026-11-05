import { euler } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  Box,
  Camera,
  Cone,
  Cylinder,
  DepthSorter,
  type Drawable,
  Ellipse,
  getSortSettingsVersion,
  Hemisphere,
  Node,
  PathShape,
  Polygon,
  Rect,
  RoundedRect,
  Scene,
  Sphere,
} from '../src/index.ts';
import { zdogFixture } from './zdog-fixture.ts';

const zdog = zdogFixture('depth-sort');

const camera = new Camera();

function ids(list: readonly Drawable[]): string[] {
  return list.map((d) => d.id);
}

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

function dot(id: string, z: number, options: ConstructorParameters<typeof PathShape>[0] = {}) {
  return new PathShape({ id, position: { x: 0, y: 0, z }, ...options });
}

describe('auto', () => {
  it('от дальних к ближним, при равной глубине — порядок дерева', () => {
    const scene = sceneWith(dot('near', 10), dot('far', -10), dot('a', 0), dot('b', 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['far', 'a', 'b', 'near']);
  });

  it('узел без рисования прозрачен: его дети сортируются вместе с соседями', () => {
    const holder = new Node({ id: 'holder' });
    holder.add(dot('inner-far', -20)).add(dot('inner-near', 20));
    const scene = sceneWith(holder, dot('middle', 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual([
      'inner-far',
      'middle',
      'inner-near',
    ]);
  });

  it('zBias сдвигает глубину, -Infinity — всегда первым', () => {
    const scene = sceneWith(
      dot('a', 0, { zBias: 5 }),
      dot('b', 3),
      dot('c', 100, { zBias: Number.NEGATIVE_INFINITY }),
    );
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['c', 'b', 'a']);
  });

  it('порядок меняется вместе с поворотом камеры', () => {
    const scene = sceneWith(
      dot('left', 0, { position: { x: -10, y: 0, z: 0 } }),
      dot('right', 0, { position: { x: 10, y: 0, z: 0 } }),
    );
    const sorter = new DepthSorter();
    const turned = new Camera({ rotation: euler.create(0, 0.5, 0) });
    expect(ids(sorter.sort(scene, turned))).toEqual(['left', 'right']);
    const other = new Camera({ rotation: euler.create(0, -0.5, 0) });
    expect(ids(sorter.sort(scene, other))).toEqual(['right', 'left']);
  });
});

describe('group', () => {
  it('поддерево сортируется как одно целое, посторонний узел не вклинивается', () => {
    const group = new Node({ id: 'group', sortMode: 'group', position: { x: 0, y: 0, z: -5 } });
    // Глубины членов: -25 и +15, но вся группа на глубине -5.
    group.add(dot('back', -20)).add(dot('front', 20));
    const scene = sceneWith(group, dot('between', 0), dot('behind', -50));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual([
      'behind',
      'back',
      'front',
      'between',
    ]);
  });

  it('рисуемый узел-группа рисуется среди своих членов по своей глубине', () => {
    const head = new Sphere({ id: 'head', sortMode: 'group' });
    head.add(dot('behind-head', -1)).add(dot('in-front', 1));
    const scene = sceneWith(head);
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['behind-head', 'head', 'in-front']);
  });
});

describe('attached', () => {
  function mascot() {
    const head = new Sphere({ id: 'head', diameter: 40 });
    const eye = new Ellipse({
      id: 'eye',
      diameter: 8,
      sortMode: 'attached',
      position: { x: 0, y: 0, z: 19 },
    });
    const pupil = new PathShape({
      id: 'pupil',
      sortMode: 'attached',
      position: { x: 0, y: 0, z: 1 },
    });
    // Глаз (z = 19) ближе уха (z = 5), но декаль рисуется сразу после головы, а не среди соседей.
    eye.add(pupil);
    head.add(eye);
    return {
      head,
      eye,
      pupil,
      scene: sceneWith(head, dot('ear', 5, { position: { x: 30, y: 0, z: 5 } })),
    };
  }

  it('декаль рисуется сразу после предка, даже если по глубине ближе соседа', () => {
    const { scene } = mascot();
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['head', 'eye', 'pupil', 'ear']);
  });

  it('декаль, отвёрнутая от камеры, не рисуется вместе со своими декалями', () => {
    const { head, scene } = mascot();
    head.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['head', 'ear']);
  });

  it('без рисуемого предка декаль сортируется как обычный узел', () => {
    const holder = new Node();
    holder.add(dot('decal', 5, { sortMode: 'attached' }));
    const scene = sceneWith(holder, dot('x', 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['x', 'decal']);
  });

  it('несколько декалей одного предка — по глубине', () => {
    const head = new Sphere({ id: 'head' });
    head.add(dot('near', 3, { sortMode: 'attached' })).add(dot('far', 1, { sortMode: 'attached' }));
    expect(ids(new DepthSorter().sort(sceneWith(head), camera))).toEqual(['head', 'far', 'near']);
  });
});

describe('layer', () => {
  it('слой под и над основным содержимым независимо от глубины', () => {
    const scene = sceneWith(
      dot('shadow', 100, { sortMode: 'layer', layer: -1 }),
      dot('body', 0),
      dot('sparkle', -100, { sortMode: 'layer', layer: 1 }),
      dot('front', 50),
    );
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual([
      'shadow',
      'body',
      'front',
      'sparkle',
    ]);
  });
});

describe('видимость и пересборка', () => {
  it('скрытый узел пропускается вместе с поддеревом, без пересборки структуры', () => {
    const group = new Node({ sortMode: 'group' });
    group.add(dot('g1', 0));
    const hidden = dot('hidden', 1);
    hidden.add(dot('hidden-child', 2));
    const scene = sceneWith(group, hidden, dot('shown', 3));
    const sorter = new DepthSorter();
    const result = sorter.sort(scene, camera);
    hidden.visible = false;
    group.visible = false;
    expect(sorter.sort(scene, camera)).toBe(result);
    expect(ids(result)).toEqual(['shown']);
    hidden.visible = true;
    expect(ids(sorter.sort(scene, camera))).toEqual(['hidden', 'hidden-child', 'shown']);
  });

  it('изменение структуры и настроек сортировки учитывается', () => {
    const a = dot('a', 0);
    const scene = sceneWith(a);
    const sorter = new DepthSorter();
    expect(ids(sorter.sort(scene, camera))).toEqual(['a']);
    scene.root.add(dot('b', -1));
    expect(ids(sorter.sort(scene, camera))).toEqual(['b', 'a']);
    a.sortMode = 'layer';
    a.layer = -1;
    expect(ids(sorter.sort(scene, camera))).toEqual(['a', 'b']);
  });

  it('камеры и узлы без рисования в результат не попадают', () => {
    const scene = sceneWith(new Camera({ id: 'cam' }), new Node({ id: 'empty' }), dot('x', 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['x']);
  });

  it('проверка настроек', () => {
    expect(() => new Node({ zBias: Number.NaN })).toThrow(RangeError);
    expect(() => new Node({ layer: 1.5 })).toThrow(RangeError);
  });
});

describe('составные фигуры', () => {
  it('полусфера: купол, потом основание', () => {
    for (const y of [0, Math.PI]) {
      const hemisphere = new Hemisphere({ id: 'h', rotation: euler.create(0, y, 0) });
      expect(ids(new DepthSorter().sort(sceneWith(hemisphere), camera))).toEqual([
        'h/dome',
        'h/base',
      ]);
    }
  });

  it('цилиндр: бок, потом основания по глубине', () => {
    const toward = new Cylinder({ id: 'c' });
    expect(ids(new DepthSorter().sort(sceneWith(toward), camera))).toEqual([
      'c/body',
      'c/rear',
      'c/front',
    ]);
    const away = new Cylinder({ id: 'c', rotation: euler.create(0, Math.PI, 0) });
    expect(ids(new DepthSorter().sort(sceneWith(away), camera))).toEqual([
      'c/body',
      'c/front',
      'c/rear',
    ]);
  });

  it('коробка — группа: грани по глубине, соседний узел не вклинивается', () => {
    const box = new Box({
      id: 'b',
      width: 10,
      height: 10,
      depth: 10,
      rotation: euler.create(-0.4, 0.5, 0),
    });
    const scene = sceneWith(box, dot('inside', 0));
    const order = ids(new DepthSorter().sort(scene, camera));
    expect(order.at(-1)).toBe('inside');
    expect(order.slice(0, 6).every((id) => id.startsWith('b/'))).toBe(true);
    // Видимые с камеры грани (передняя, правая, верхняя при таком повороте) — последними.
    expect(order.indexOf('b/front')).toBeGreaterThan(order.indexOf('b/rear'));
  });
});

describe('совместимость с Zdog в режиме auto', () => {
  it('порядок плоских фигур совпадает с сортировкой Zdog', () => {
    const rotate = { x: -0.35, y: 0.9, z: 0.2 };
    const specs = [
      { translate: { x: -40, y: 0, z: 10 } },
      { translate: { x: 0, y: 10, z: -30 } },
      { translate: { x: 30, y: -10, z: 5 } },
      { translate: { x: 5, y: 25, z: 40 } },
      { translate: { x: -15, y: -25, z: -12 } },
    ];
    const zdogOrder = zdog.next<number[]>('плоские фигуры', { rotate, specs });

    const root = new Node({ rotation: euler.create(rotate.x, -rotate.y, rotate.z) });
    const at = (i: number) => {
      const t = specs[i]?.translate ?? { x: 0, y: 0, z: 0 };
      return { id: `s${i}`, position: { x: t.x, y: t.y, z: t.z } };
    };
    root
      .add(new Rect({ ...at(0), width: 20, height: 10 }))
      .add(new Ellipse({ ...at(1), diameter: 14 }))
      .add(new Polygon({ ...at(2), radius: 9, sides: 5 }))
      .add(new RoundedRect({ ...at(3), width: 16, height: 12, cornerRadius: 3 }))
      .add(
        new PathShape({
          ...at(4),
          path: [
            { type: 'move', point: { x: -5, z: -8 } },
            { type: 'line', point: { x: 5, z: 8 } },
          ],
        }),
      );
    const scene = new Scene(root);
    const ourOrder = ids(new DepthSorter().sort(scene, camera)).map((id) => Number(id.slice(1)));
    expect(ourOrder).toEqual(zdogOrder);
  });
});

describe('пересортировка в следующих кадрах', () => {
  it('после движения узла порядок обновляется без пересборки, массив тот же', () => {
    const a = dot('a', -1);
    const b = dot('b', 1);
    const scene = sceneWith(a, b);
    const sorter = new DepthSorter();
    const result = sorter.sort(scene, camera);
    expect(ids(result)).toEqual(['a', 'b']);
    const version = getSortSettingsVersion();
    a.position.z = 50;
    a.zBias = 0;
    expect(sorter.sort(scene, camera)).toBe(result);
    expect(ids(result)).toEqual(['b', 'a']);
    expect(getSortSettingsVersion()).toBe(version);
    expect(sorter.sort(scene, camera)).toBe(result);
  });

  it('анимация zBias не пересобирает структуру', () => {
    const a = dot('a', 0);
    const b = dot('b', 1);
    const scene = sceneWith(a, b);
    const sorter = new DepthSorter();
    sorter.sort(scene, camera);
    const version = getSortSettingsVersion();
    for (const bias of [2, 0, 5]) {
      a.zBias = bias;
      expect(ids(sorter.sort(scene, camera))).toEqual(bias > 1 ? ['b', 'a'] : ['a', 'b']);
    }
    expect(getSortSettingsVersion()).toBe(version);
  });

  it('тот же сортировщик с другой сценой пересобирается даже при равных версиях', () => {
    const sorter = new DepthSorter();
    expect(ids(sorter.sort(sceneWith(dot('x', 0)), camera))).toEqual(['x']);
    expect(ids(sorter.sort(sceneWith(dot('y', 0)), camera))).toEqual(['y']);
  });
});

describe('счётчик настроек сортировки', () => {
  it('sortMode и layer в режиме layer увеличивают его на 1, то же значение — нет', () => {
    const node = new Node();
    const step = (change: () => void) => {
      const before = getSortSettingsVersion();
      change();
      return getSortSettingsVersion() - before;
    };
    expect(step(() => (node.sortMode = 'auto'))).toBe(0);
    expect(step(() => (node.layer = 3))).toBe(0);
    expect(step(() => (node.sortMode = 'layer'))).toBe(1);
    expect(step(() => (node.layer = 3))).toBe(0);
    expect(step(() => (node.layer = 4))).toBe(1);
    expect(step(() => (node.zBias = 7))).toBe(0);
    expect(step(() => (node.visible = false))).toBe(0);
    expect(() => {
      node.zBias = Number.NaN;
    }).toThrow(RangeError);
    expect(node.zBias).toBe(7);
  });
});

describe('точка сортировки', () => {
  it('фигура с путём: среднее концов команд без повтора начальной точки', () => {
    const point = { x: 0, y: 0, z: 0 };
    const rect = new Rect({ width: 10, height: 4 });
    expect(rect.getSortPoint(point)).toEqual({ x: 0, y: 0, z: 0 });
    // Скруглённый прямоугольник возвращается в начало: повтор не учитывается.
    expect(new RoundedRect({ width: 10, height: 4 }).getSortPoint(point).x).toBeCloseTo(0, 12);
    const closedTriangle = new PathShape({
      path: [
        { type: 'move', point: { x: 0 } },
        { type: 'line', point: { x: 6 } },
        { type: 'line', point: { x: 0, y: 3 } },
        { type: 'line', point: { x: 0 } },
      ],
    });
    expect(closedTriangle.getSortPoint(point)).toEqual({ x: 2, y: 1, z: 0 });
    // Из двух точек повтор не убирается: Zdog так считает только для путей длиннее двух.
    const twice = new PathShape({
      path: [
        { type: 'move', point: { z: 4 } },
        { type: 'line', point: { z: 4 } },
      ],
    });
    expect(twice.getSortPoint(point).z).toBe(4);
  });

  it('кэш точки сбрасывается при изменении геометрии', () => {
    const point = { x: 0, y: 0, z: 0 };
    const ellipse = new Ellipse({ diameter: 10 });
    expect(ellipse.getSortPoint(point).x).toBeCloseTo(0, 12);
    // Одна четверть: концы (0, −5) и (5, 0), среднее (2.5, −2.5).
    ellipse.quarters = 1;
    expect(ellipse.getSortPoint(point)).toEqual({ x: 2.5, y: -2.5, z: 0 });
  });

  it('центроиды полусферы и конуса', () => {
    const point = { x: 0, y: 0, z: 0 };
    expect(new Hemisphere({ diameter: 16 }).getSortPoint(point).z).toBe(3);
    expect(new Cone({ length: 9 }).getSortPoint(point).z).toBe(3);
  });
});

describe('составные фигуры в любом режиме сортируются как группа', () => {
  it('auto, layer и attached не уводят бок цилиндра за дальние объекты', () => {
    for (const sortMode of ['auto', 'layer', 'attached'] as const) {
      const cylinder = new Cylinder({ id: 'cyl', sortMode, position: { x: 0, y: 0, z: 50 } });
      const scene = sceneWith(dot('far', -100), cylinder);
      expect(ids(new DepthSorter().sort(scene, camera)), sortMode).toEqual([
        'far',
        'cyl/body',
        'cyl/rear',
        'cyl/front',
      ]);
    }
  });

  it('layer у составной фигуры и у пустого контейнера', () => {
    const cylinder = new Cylinder({
      id: 'cyl',
      sortMode: 'layer',
      layer: 1,
      position: { x: 0, y: 0, z: -100 },
    });
    const background = new Node({ id: 'bg', sortMode: 'layer', layer: -1 });
    background.add(dot('bg-near', 100)).add(dot('bg-far', 90));
    const scene = sceneWith(cylinder, dot('mid', 0), background);
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual([
      'bg-far',
      'bg-near',
      'mid',
      'cyl/body',
      'cyl/rear',
      'cyl/front',
    ]);
  });

  it('декаль на составной фигуре рисуется после неё и скрывается, когда отвёрнута', () => {
    const head = new Hemisphere({ id: 'head', diameter: 40 });
    const eye = dot('eye', 0, { sortMode: 'attached', position: { x: 0, y: 0, z: 10 } });
    head.add(eye);
    // Глубина полусферы — её центроид (z = 7.5), ухо на z = 10 ближе.
    const scene = sceneWith(head, dot('ear', 10));
    const sorter = new DepthSorter();
    expect(ids(sorter.sort(scene, camera))).toEqual(['head/dome', 'head/base', 'eye', 'ear']);
    head.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(ids(sorter.sort(scene, camera))).toEqual(['head/dome', 'head/base', 'ear']);
  });

  it('порядок частей конуса: поверхность, потом основание', () => {
    const cone = new Cone({ id: 'k', rotation: euler.create(1.2, 0, 0) });
    expect(ids(new DepthSorter().sort(sceneWith(cone), camera))).toEqual(['k/surface', 'k/base']);
  });
});

describe('декали: тонкие случаи', () => {
  function face() {
    const head = new Sphere({ id: 'head', diameter: 40 });
    const eye = new Ellipse({
      id: 'eye',
      diameter: 8,
      sortMode: 'attached',
      position: { x: 0, y: 0, z: 19 },
    });
    const pupil = new PathShape({
      id: 'pupil',
      sortMode: 'attached',
      position: { x: 0, y: 0, z: 1 },
    });
    eye.add(pupil);
    head.add(eye);
    return { head, eye, pupil, scene: sceneWith(head) };
  }

  it('отвёрнутый глаз скрывает зрачок; отвёрнутый зрачок не трогает глаз', () => {
    const a = face();
    a.eye.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(ids(new DepthSorter().sort(a.scene, camera))).toEqual(['head']);
    const b = face();
    b.pupil.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(ids(new DepthSorter().sort(b.scene, camera))).toEqual(['head', 'eye']);
  });

  it('обращённость считается от камеры: повёрнутая и перспективная', () => {
    const { scene } = face();
    const behind = new Camera({ rotation: euler.create(0, Math.PI, 0) });
    expect(ids(new DepthSorter().sort(scene, behind))).toEqual(['head']);
    const perspective = new Camera({ projection: 'perspective', distance: 200 });
    expect(ids(new DepthSorter().sort(scene, perspective))).toEqual(['head', 'eye', 'pupil']);
  });

  it('декаль внутри группы прикрепляется к рисуемому узлу-группе', () => {
    const head = new Sphere({ id: 'head', sortMode: 'group' });
    // Глаз глубже всех, но как декаль рисуется сразу после головы.
    head.add(dot('eye', -5, { sortMode: 'attached' }));
    head.add(dot('behind', -1));
    expect(ids(new DepthSorter().sort(sceneWith(head), camera))).toEqual(['behind', 'head', 'eye']);
  });
});

describe('группы: вложенность и слои', () => {
  it('слой внутри группы действует только в ней', () => {
    const group = new Node({ id: 'g', sortMode: 'group', position: { x: 0, y: 0, z: 10 } });
    group.add(dot('top', -50, { sortMode: 'layer', layer: 1 })).add(dot('inner', 0));
    const scene = sceneWith(group, dot('outside', 100));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['inner', 'top', 'outside']);
  });

  it('вложенные группы', () => {
    const outer = new Node({ sortMode: 'group' });
    const inner = new Node({ sortMode: 'group', position: { x: 0, y: 0, z: 5 } });
    inner.add(dot('i1', -10)).add(dot('i2', 10));
    outer.add(inner).add(dot('o1', 0));
    expect(ids(new DepthSorter().sort(sceneWith(outer), camera))).toEqual(['o1', 'i1', 'i2']);
  });

  it('zBias +Infinity — всегда последним, скрытый корень — ничего', () => {
    const scene = sceneWith(dot('a', 100), dot('b', 0, { zBias: Number.POSITIVE_INFINITY }));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['a', 'b']);
    scene.root.visible = false;
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual([]);
  });
});

describe('совместимость с Zdog: несколько поворотов, коробка', () => {
  const rotations = [
    { x: -0.35, y: 0.9, z: 0.2 },
    { x: 0.6, y: -2.1, z: 0 },
    { x: 1.3, y: 0.3, z: -0.5 },
  ];

  it('порядок плоских фигур совпадает с Zdog в нескольких ракурсах', () => {
    for (const rotate of rotations) {
      const translates = [
        { x: -40, y: 0, z: 10 },
        { x: 0, y: 10, z: -30 },
        { x: 30, y: -10, z: 5 },
        { x: 5, y: 25, z: 40 },
      ];
      const at = (i: number) => translates[i] ?? { x: 0, y: 0, z: 0 };
      const zdogOrder = zdog.next<number[]>('ракурсы', { rotate, translates });

      const root = new Node({ rotation: euler.create(rotate.x, -rotate.y, rotate.z) });
      const p = (i: number) => ({ id: `s${i}`, position: at(i) });
      root
        .add(new Rect({ ...p(0), width: 20, height: 10 }))
        .add(new Ellipse({ ...p(1), diameter: 14 }))
        .add(new Polygon({ ...p(2), radius: 9, sides: 5 }))
        .add(new RoundedRect({ ...p(3), width: 16, height: 12 }));
      const order = ids(new DepthSorter().sort(new Scene(root), camera)).map((id) =>
        Number(id.slice(1)),
      );
      expect(order, JSON.stringify(rotate)).toEqual(zdogOrder);
    }
  });

  it('грани отдельной коробки — в том же порядке, что у Zdog', () => {
    for (const rotate of rotations) {
      const zdogOrder = zdog.next<string[]>('коробка', { rotate });

      const root = new Node({ rotation: euler.create(rotate.x, -rotate.y, rotate.z) });
      root.add(new Box({ id: 'box', width: 20, height: 30, depth: 40 }));
      const order = ids(new DepthSorter().sort(new Scene(root), camera)).map((id) => id.slice(4));
      expect(order, JSON.stringify(rotate)).toEqual(zdogOrder);
    }
  });
});
