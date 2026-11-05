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
  it('far to near, tree order at equal depth', () => {
    const scene = sceneWith(dot('near', 10), dot('far', -10), dot('a', 0), dot('b', 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['far', 'a', 'b', 'near']);
  });

  it('a non-drawable node is transparent: its children sort together with its siblings', () => {
    const holder = new Node({ id: 'holder' });
    holder.add(dot('inner-far', -20)).add(dot('inner-near', 20));
    const scene = sceneWith(holder, dot('middle', 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual([
      'inner-far',
      'middle',
      'inner-near',
    ]);
  });

  it('zBias shifts depth, -Infinity is always first', () => {
    const scene = sceneWith(
      dot('a', 0, { zBias: 5 }),
      dot('b', 3),
      dot('c', 100, { zBias: Number.NEGATIVE_INFINITY }),
    );
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['c', 'b', 'a']);
  });

  it('order changes with camera rotation', () => {
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
  it('a subtree sorts as one unit, an outside node does not get in between', () => {
    const group = new Node({ id: 'group', sortMode: 'group', position: { x: 0, y: 0, z: -5 } });
    // Member depths are -25 and +15, but the whole group is at depth -5.
    group.add(dot('back', -20)).add(dot('front', 20));
    const scene = sceneWith(group, dot('between', 0), dot('behind', -50));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual([
      'behind',
      'back',
      'front',
      'between',
    ]);
  });

  it('a drawable group node is drawn among its members by its own depth', () => {
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
    // The eye (z = 19) is closer than the ear (z = 5), but a decal is drawn right after the head, not among siblings.
    eye.add(pupil);
    head.add(eye);
    return {
      head,
      eye,
      pupil,
      scene: sceneWith(head, dot('ear', 5, { position: { x: 30, y: 0, z: 5 } })),
    };
  }

  it('a decal is drawn right after its ancestor even if it is closer than a sibling', () => {
    const { scene } = mascot();
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['head', 'eye', 'pupil', 'ear']);
  });

  it('a decal facing away from the camera is not drawn, nor are its decals', () => {
    const { head, scene } = mascot();
    head.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['head', 'ear']);
  });

  it('without a drawable ancestor a decal sorts as a regular node', () => {
    const holder = new Node();
    holder.add(dot('decal', 5, { sortMode: 'attached' }));
    const scene = sceneWith(holder, dot('x', 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['x', 'decal']);
  });

  it('several decals of one ancestor sort by depth', () => {
    const head = new Sphere({ id: 'head' });
    head.add(dot('near', 3, { sortMode: 'attached' })).add(dot('far', 1, { sortMode: 'attached' }));
    expect(ids(new DepthSorter().sort(sceneWith(head), camera))).toEqual(['head', 'far', 'near']);
  });
});

describe('layer', () => {
  it('layers below and above the main content regardless of depth', () => {
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

describe('visibility and rebuild', () => {
  it('a hidden node is skipped with its subtree, without a structure rebuild', () => {
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

  it('structure and sort setting changes are picked up', () => {
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

  it('cameras and non-drawable nodes are not in the result', () => {
    const scene = sceneWith(new Camera({ id: 'cam' }), new Node({ id: 'empty' }), dot('x', 0));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['x']);
  });

  it('settings validation', () => {
    expect(() => new Node({ zBias: Number.NaN })).toThrow(RangeError);
    expect(() => new Node({ layer: 1.5 })).toThrow(RangeError);
  });
});

describe('solids', () => {
  it('hemisphere: dome, then base', () => {
    for (const y of [0, Math.PI]) {
      const hemisphere = new Hemisphere({ id: 'h', rotation: euler.create(0, y, 0) });
      expect(ids(new DepthSorter().sort(sceneWith(hemisphere), camera))).toEqual([
        'h/dome',
        'h/base',
      ]);
    }
  });

  it('cylinder: side, then bases by depth', () => {
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

  it('a box is a group: faces by depth, a sibling node does not get in between', () => {
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
    // Faces visible from the camera (front, right, top at this rotation) come last.
    expect(order.indexOf('b/front')).toBeGreaterThan(order.indexOf('b/rear'));
  });
});

describe('Zdog compatibility in auto mode', () => {
  it('flat shape order matches the Zdog sort', () => {
    const rotate = { x: -0.35, y: 0.9, z: 0.2 };
    const specs = [
      { translate: { x: -40, y: 0, z: 10 } },
      { translate: { x: 0, y: 10, z: -30 } },
      { translate: { x: 30, y: -10, z: 5 } },
      { translate: { x: 5, y: 25, z: 40 } },
      { translate: { x: -15, y: -25, z: -12 } },
    ];
    const zdogOrder = zdog.next<number[]>('flat shapes', { rotate, specs });

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

describe('re-sorting in later frames', () => {
  it('after a node moves the order updates without a rebuild, same array', () => {
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

  it('animating zBias does not rebuild the structure', () => {
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

  it('the same sorter with another scene rebuilds even with equal versions', () => {
    const sorter = new DepthSorter();
    expect(ids(sorter.sort(sceneWith(dot('x', 0)), camera))).toEqual(['x']);
    expect(ids(sorter.sort(sceneWith(dot('y', 0)), camera))).toEqual(['y']);
  });
});

describe('sort settings counter', () => {
  it('sortMode and layer in layer mode increase it by 1, the same value does not', () => {
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

describe('sort point', () => {
  it('path shape: mean of command end points without the repeated start point', () => {
    const point = { x: 0, y: 0, z: 0 };
    const rect = new Rect({ width: 10, height: 4 });
    expect(rect.getSortPoint(point)).toEqual({ x: 0, y: 0, z: 0 });
    // A rounded rect returns to its start: the repeat is not counted.
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
    // With two points the repeat is kept: Zdog drops it only for paths longer than two.
    const twice = new PathShape({
      path: [
        { type: 'move', point: { z: 4 } },
        { type: 'line', point: { z: 4 } },
      ],
    });
    expect(twice.getSortPoint(point).z).toBe(4);
  });

  it('the point cache resets on geometry change', () => {
    const point = { x: 0, y: 0, z: 0 };
    const ellipse = new Ellipse({ diameter: 10 });
    expect(ellipse.getSortPoint(point).x).toBeCloseTo(0, 12);
    // One quarter: ends (0, −5) and (5, 0), mean (2.5, −2.5).
    ellipse.quarters = 1;
    expect(ellipse.getSortPoint(point)).toEqual({ x: 2.5, y: -2.5, z: 0 });
  });

  it('hemisphere and cone centroids', () => {
    const point = { x: 0, y: 0, z: 0 };
    expect(new Hemisphere({ diameter: 16 }).getSortPoint(point).z).toBe(3);
    expect(new Cone({ length: 9 }).getSortPoint(point).z).toBe(3);
  });
});

describe('solids sort as a group in any mode', () => {
  it('auto, layer and attached do not push the cylinder side behind far objects', () => {
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

  it('layer on a solid and on an empty container', () => {
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

  it('a decal on a solid is drawn after it and hidden when facing away', () => {
    const head = new Hemisphere({ id: 'head', diameter: 40 });
    const eye = dot('eye', 0, { sortMode: 'attached', position: { x: 0, y: 0, z: 10 } });
    head.add(eye);
    // The hemisphere depth is its centroid (z = 7.5), the ear at z = 10 is closer.
    const scene = sceneWith(head, dot('ear', 10));
    const sorter = new DepthSorter();
    expect(ids(sorter.sort(scene, camera))).toEqual(['head/dome', 'head/base', 'eye', 'ear']);
    head.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(ids(sorter.sort(scene, camera))).toEqual(['head/dome', 'head/base', 'ear']);
  });

  it('cone part order: surface, then base', () => {
    const cone = new Cone({ id: 'k', rotation: euler.create(1.2, 0, 0) });
    expect(ids(new DepthSorter().sort(sceneWith(cone), camera))).toEqual(['k/surface', 'k/base']);
  });
});

describe('decals: edge cases', () => {
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

  it('an eye facing away hides the pupil; a pupil facing away does not affect the eye', () => {
    const a = face();
    a.eye.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(ids(new DepthSorter().sort(a.scene, camera))).toEqual(['head']);
    const b = face();
    b.pupil.setRotationFromEuler(euler.create(0, Math.PI, 0));
    expect(ids(new DepthSorter().sort(b.scene, camera))).toEqual(['head', 'eye']);
  });

  it('facing is relative to the camera: rotated and perspective', () => {
    const { scene } = face();
    const behind = new Camera({ rotation: euler.create(0, Math.PI, 0) });
    expect(ids(new DepthSorter().sort(scene, behind))).toEqual(['head']);
    const perspective = new Camera({ projection: 'perspective', distance: 200 });
    expect(ids(new DepthSorter().sort(scene, perspective))).toEqual(['head', 'eye', 'pupil']);
  });

  it('a decal inside a group attaches to the drawable group node', () => {
    const head = new Sphere({ id: 'head', sortMode: 'group' });
    // The eye is deepest of all, but as a decal it is drawn right after the head.
    head.add(dot('eye', -5, { sortMode: 'attached' }));
    head.add(dot('behind', -1));
    expect(ids(new DepthSorter().sort(sceneWith(head), camera))).toEqual(['behind', 'head', 'eye']);
  });
});

describe('groups: nesting and layers', () => {
  it('a layer inside a group applies only within it', () => {
    const group = new Node({ id: 'g', sortMode: 'group', position: { x: 0, y: 0, z: 10 } });
    group.add(dot('top', -50, { sortMode: 'layer', layer: 1 })).add(dot('inner', 0));
    const scene = sceneWith(group, dot('outside', 100));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['inner', 'top', 'outside']);
  });

  it('nested groups', () => {
    const outer = new Node({ sortMode: 'group' });
    const inner = new Node({ sortMode: 'group', position: { x: 0, y: 0, z: 5 } });
    inner.add(dot('i1', -10)).add(dot('i2', 10));
    outer.add(inner).add(dot('o1', 0));
    expect(ids(new DepthSorter().sort(sceneWith(outer), camera))).toEqual(['o1', 'i1', 'i2']);
  });

  it('zBias +Infinity is always last, a hidden root gives nothing', () => {
    const scene = sceneWith(dot('a', 100), dot('b', 0, { zBias: Number.POSITIVE_INFINITY }));
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual(['a', 'b']);
    scene.root.visible = false;
    expect(ids(new DepthSorter().sort(scene, camera))).toEqual([]);
  });
});

describe('Zdog compatibility: several rotations, box', () => {
  const rotations = [
    { x: -0.35, y: 0.9, z: 0.2 },
    { x: 0.6, y: -2.1, z: 0 },
    { x: 1.3, y: 0.3, z: -0.5 },
  ];

  it('flat shape order matches Zdog from several view angles', () => {
    for (const rotate of rotations) {
      const translates = [
        { x: -40, y: 0, z: 10 },
        { x: 0, y: 10, z: -30 },
        { x: 30, y: -10, z: 5 },
        { x: 5, y: 25, z: 40 },
      ];
      const at = (i: number) => translates[i] ?? { x: 0, y: 0, z: 0 };
      const zdogOrder = zdog.next<number[]>('view angles', { rotate, translates });

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

  it('faces of a standalone box are in the same order as in Zdog', () => {
    for (const rotate of rotations) {
      const zdogOrder = zdog.next<string[]>('box', { rotate });

      const root = new Node({ rotation: euler.create(rotate.x, -rotate.y, rotate.z) });
      root.add(new Box({ id: 'box', width: 20, height: 30, depth: 40 }));
      const order = ids(new DepthSorter().sort(new Scene(root), camera)).map((id) => id.slice(4));
      expect(order, JSON.stringify(rotate)).toEqual(zdogOrder);
    }
  });
});
