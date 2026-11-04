import { euler } from '@mascotte/math';
import Zdog from '@mascotte/zdog-reference';
import { describe, expect, it } from 'vitest';
import {
  Box,
  Camera,
  Cylinder,
  DepthSorter,
  type Drawable,
  Ellipse,
  Hemisphere,
  Node,
  PathShape,
  Polygon,
  Rect,
  RoundedRect,
  Scene,
  Sphere,
} from '../src/index.ts';

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
    // Глаз чуть глубже головы по точке сортировки не уйдёт за неё: декаль рисуется сразу после.
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
    const zdogRoot = new Zdog.Anchor({ rotate });
    const specs = [
      { translate: { x: -40, y: 0, z: 10 } },
      { translate: { x: 0, y: 10, z: -30 } },
      { translate: { x: 30, y: -10, z: 5 } },
      { translate: { x: 5, y: 25, z: 40 } },
      { translate: { x: -15, y: -25, z: -12 } },
    ];
    const zdogShapes = [
      new Zdog.Rect({ addTo: zdogRoot, width: 20, height: 10, ...specs[0] }),
      new Zdog.Ellipse({ addTo: zdogRoot, diameter: 14, ...specs[1] }),
      new Zdog.Polygon({ addTo: zdogRoot, radius: 9, sides: 5, ...specs[2] }),
      new Zdog.RoundedRect({
        addTo: zdogRoot,
        width: 16,
        height: 12,
        cornerRadius: 3,
        ...specs[3],
      }),
      new Zdog.Shape({
        addTo: zdogRoot,
        path: [
          { x: -5, z: -8 },
          { x: 5, z: 8 },
        ],
        ...specs[4],
      }),
    ];
    zdogRoot.updateGraph();
    const graph = (zdogRoot as unknown as { flatGraph: unknown[] }).flatGraph;
    const zdogOrder = graph
      .filter((item) => zdogShapes.includes(item as never))
      .map((item) => zdogShapes.indexOf(item as never));

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
