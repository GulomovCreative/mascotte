import { Animator, Box, Cylinder, Ellipse, Node, PathShape, Scene, Sphere } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import {
  animateDocument,
  buildDocument,
  DocumentError,
  FORMAT,
  MAX_DEPTH,
  type MascotDocument,
  migrate,
  readDocument,
  VERSION,
  validateDocument,
  writeNode,
} from '../src/index.ts';

/** A small valid document: a head with an eye, a slot, a clip on a layer and a machine. */
function sample(): MascotDocument {
  return {
    format: FORMAT,
    version: VERSION,
    meta: { name: 'Ball' },
    view: { width: 100, height: 100, background: '#ffffff' },
    camera: { props: { zoom: 2 } },
    root: {
      type: 'Node',
      id: 'root',
      children: [
        {
          type: 'Sphere',
          id: 'head',
          props: { diameter: 40, 'style.color': '#f6a623' },
          children: [{ type: 'Sphere', id: 'eye', props: { diameter: 6 } }],
        },
      ],
    },
    rig: { slots: { head: 'head' } },
    motions: {
      nod: {
        duration: 1,
        loop: 'loop',
        tracks: [
          {
            target: { slot: 'head' },
            property: 'position',
            keys: [
              { time: 0, value: { x: 0, y: 0, z: 0 } },
              { time: 1, value: { x: 0, y: 10, z: 0 } },
            ],
          },
        ],
      },
    },
    layers: [{ name: 'base', play: 'nod' }, { name: 'face' }],
    machines: [
      {
        layer: 'face',
        inputs: [{ name: 'poke', type: 'trigger' }],
        states: [{ name: 'calm' }, { name: 'nod', motion: 'nod' }],
        transitions: [{ from: 'calm', to: 'nod', conditions: [{ input: 'poke' }] }],
      },
    ],
    constraints: [{ name: 'gaze', kind: 'aim', target: { slot: 'head' }, weight: 0 }],
    springs: [{ target: 'eye', tip: { x: 0, y: 5, z: 0 } }],
  };
}

// biome-ignore lint/suspicious/noExplicitAny: tests break documents in arbitrary places.
type Loose = Record<string, any>;

/** The sample with `change` applied to a copy, for invalid variants. */
function broken(change: (document: Loose) => void): unknown {
  const document = structuredClone(sample()) as Loose;
  change(document);
  return document;
}

function issues(value: unknown): string[] {
  return validateDocument(value).map((issue) => `${issue.path}: ${issue.message}`);
}

describe('validateDocument', () => {
  it('accepts a valid document', () => {
    expect(issues(sample())).toEqual([]);
  });

  it('reports node problems with their paths, all at once', () => {
    const found = issues(
      broken((d) => {
        const head = d.root.children[0];
        head.type = 'Spere';
        d.root.children.push(
          { type: 'Sphere', id: 'head', props: { diameter: -1, opacity: 2, sortMode: 'top' } },
          {
            type: 'Ellipse',
            props: { quarters: 2.5, 'style.color': 'nope', rotation: { x: 0, y: 0, z: 0, w: 0 } },
          },
          { type: 'Sphere', props: { radius: 3 }, path: [], colour: 1 },
        );
      }),
    );
    expect(found).toEqual([
      expect.stringMatching(/^root\.children\[0\]\.type: expected one of Node, .*, got "Spere"\.$/),
      'root.children[1].id: the id "head" is used twice.',
      'root.children[1].props.diameter: expected a number at least 0, got -1.',
      'root.children[1].props.opacity: expected at most 1, got 2.',
      'root.children[1].props.sortMode: expected one of auto, group, attached, layer, got "top".',
      'root.children[2].props.quarters: expected an integer, got 2.5.',
      'root.children[2].props.style.color: expected a CSS color, got "nope".',
      'root.children[2].props.rotation: expected a unit quaternion, got one of length 0.',
      expect.stringMatching(/^root\.children\[3\]\.colour: unknown field/),
      expect.stringMatching(
        /^root\.children\[3\]\.props\.radius: Sphere has no property "radius" \(it has .*diameter/,
      ),
      'root.children[3].path: only a PathShape has a path.',
    ]);
  });

  it('checks paths and box faces', () => {
    const found = issues(
      broken((d) => {
        d.root.children.push(
          { type: 'PathShape', path: [{ type: 'line', point: { x: 'a' } }, { type: 'curve' }] },
          { type: 'Box', faces: { front: { visible: 1 }, side: {} } },
        );
      }),
    );
    expect(found).toEqual([
      'root.children[1].path[0].point.x: expected a finite number, got "a".',
      'root.children[1].path[1].type: expected one of move, line, bezier, arc, got "curve".',
      'root.children[2].faces.side: unknown field (expected one of front, rear, left, right, top, bottom).',
      'root.children[2].faces.front.visible: expected true or false, got 1.',
    ]);
  });

  it('checks the names that refer to each other', () => {
    const found = issues(
      broken((d) => {
        d.rig.slots['ear.L'] = 'ear';
        d.rig.slots['2x'] = 'head';
        d.layers[0].play = 'wave';
        d.layers.push({ name: 'base', mode: 'mix' });
        d.machines[0].layer = 'body';
        d.machines[0].states[1].motion = 'hop';
        d.constraints.push({ kind: 'grab' });
        d.motions.bad = { keys: [] };
      }),
    );
    expect(found).toEqual([
      'rig.slots.ear.L: no node with id "ear".',
      'rig.slots.2x: "2x" is not a slot name.',
      'motions.bad: expected a clip {tracks}, behaviors {behaviors}, blend {input, blend} or library motion {library}.',
      'layers[0].play: no motion "wave" in motions (there are nod, bad).',
      'layers[2].name: the name "base" is used twice.',
      'layers[2].mode: expected one of override, additive, got "mix".',
      'machines[0].layer: no layer "body" in layers.',
      'machines[0].states[1].motion: no motion "hop" in motions (there are nod, bad).',
      expect.stringMatching(/^constraints\[1\]\.kind: expected one of aim, .*got "grab"\.$/),
    ]);
  });

  it('checks the document frame', () => {
    expect(issues([])).toEqual([': expected a document object, got [].']);
    expect(
      issues(
        broken((d) => {
          d.meta = { name: '' };
          d.view = { width: 0, height: 10, background: 'blue-ish' };
          d.camera.props.zoom = 'big';
          d.extra = true;
          d.root = null;
        }),
      ),
    ).toEqual([
      expect.stringMatching(/^extra: unknown field/),
      'meta.name: expected a non-empty string, got "".',
      'view.width: expected a finite number above 0, got 0.',
      'view.background: expected a CSS color, got "blue-ish".',
      'camera.props.zoom: expected a finite number, got "big".',
      'root: expected a node, got null.',
      // Without a tree the slots bind nothing.
      'rig.slots.head: no node with id "head".',
    ]);
  });
});

describe('validateDocument against hostile or tricky input', () => {
  it('finds no command type or motion on the object prototype', () => {
    const found = issues(
      broken((d) => {
        d.root.children.push({ type: 'PathShape', path: [{ type: 'constructor' }] });
        d.layers[0].play = 'toString';
      }),
    );
    expect(found).toEqual([
      'root.children[1].path[0].type: expected one of move, line, bezier, arc, got "constructor".',
      'layers[0].play: no motion "toString" in motions (there are nod).',
    ]);
  });

  it('refuses a tree nested deeper than MAX_DEPTH instead of overflowing', () => {
    const deep = broken((d) => {
      let node = d.root;
      for (let i = 0; i < 10_000; i++) {
        const child = { type: 'Node' };
        node.children = [child];
        node = child;
      }
      d.rig = {};
    });
    const found = issues(deep);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      new RegExp(`: the tree is nested deeper than ${MAX_DEPTH} levels\\.$`),
    );
    expect(() => buildDocument(deep as MascotDocument)).toThrow(DocumentError);
  });

  it('refuses a blend in a blend, named or inline, as the engine does', () => {
    const found = issues(
      broken((d) => {
        d.motions.a = { input: 'x', blend: [{ at: 0, motion: 'a' }] };
        d.motions.b = {
          input: 'x',
          blend: [{ at: 0, motion: { input: 'x', blend: [{ at: 0, motion: 'c' }] } }],
        };
        d.motions.c = { input: 'x', blend: [{ at: 1, motion: 'b' }] };
      }),
    );
    // So no chain of names can blend a motion into itself or nest blends deeply.
    expect(found).toEqual([
      'motions.a.blend[0].motion: a blend point cannot be a blend: blends do not nest.',
      'motions.b.blend[0].motion: a blend point cannot be a blend: blends do not nest.',
      'motions.c.blend[0].motion: a blend point cannot be a blend: blends do not nest.',
    ]);
  });

  it('checks blends, their points and inline motions', () => {
    const found = issues(
      broken((d) => {
        d.motions.lean = { input: '', blend: [{ motion: 'nope' }, 3] };
        d.layers[0].play = { keys: [] };
        d.constraints.push({ name: 'gaze', kind: 'aim', target: 'head' });
        d.machines[0].name = null;
        d.root.children.push({ type: 'Node', id: '~1' }, { type: 'Node', id: 'a/b' });
      }),
    );
    expect(found).toEqual([
      'root.children[1].id: an id cannot start with "~" or contain "/", got "~1".',
      'root.children[2].id: an id cannot start with "~" or contain "/", got "a/b".',
      'motions.lean.input: expected a non-empty string, got "".',
      'motions.lean.blend[0].at: expected a finite number, got undefined.',
      'motions.lean.blend[0].motion: no motion "nope" in motions (there are nod, lean).',
      'motions.lean.blend[1]: expected a blend point {at, motion}, got 3.',
      'layers[0].play: expected a clip {tracks}, behaviors {behaviors}, blend {input, blend} or library motion {library}.',
      'constraints[1].name: the name "gaze" is used twice.',
    ]);
  });

  it('accepts only unit rotation quaternions, and checks camera properties', () => {
    const found = issues(
      broken((d) => {
        d.root.props = { rotation: { x: 0, y: 0, z: 0, w: 2 } };
        d.camera.props.fov = 30;
      }),
    );
    expect(found).toEqual([
      expect.stringMatching(/^camera\.props\.fov: Camera has no property "fov" \(it has .*zoom/),
      'root.props.rotation: expected a unit quaternion, got one of length 2.',
    ]);
  });
});

describe('migrate and readDocument', () => {
  it('rejects what is not a mascot document of a known version', () => {
    const message = (value: unknown) => {
      try {
        readDocument(value);
      } catch (error) {
        expect(error).toBeInstanceOf(DocumentError);
        return (error as DocumentError).issues[0]?.message;
      }
      return 'no error';
    };
    expect(message('{"format": ')).toMatch(/^not JSON: /);
    expect(message('[]')).toBe('expected a document object.');
    expect(message({ format: 'zdog', version: 1 })).toMatch(/not a mascot document/);
    expect(message({ format: FORMAT, version: 1.5 })).toBe(
      'expected a whole number from 1, got 1.5.',
    );
    expect(message({ format: FORMAT, version: VERSION + 1 })).toBe(
      `the document has version ${VERSION + 1}, newer than ${VERSION} this reader knows.`,
    );
  });

  it('applies the migrations from the document version up, in order', () => {
    const steps = [
      (d: Record<string, unknown>) => ({ ...d, title: d.name }),
      (d: Record<string, unknown>) => ({ ...d, meta: { name: d.title } }),
    ];
    expect(migrate({ format: FORMAT, version: 1, name: 'Old' }, steps)).toEqual({
      format: FORMAT,
      version: 3,
      name: 'Old',
      title: 'Old',
      meta: { name: 'Old' },
    });
    expect(migrate({ format: FORMAT, version: 2, title: 'Mid' }, steps)).toEqual({
      format: FORMAT,
      version: 3,
      title: 'Mid',
      meta: { name: 'Mid' },
    });
  });

  it('works on a copy and reports a failing or empty migration', () => {
    const old = { format: FORMAT, version: 1, meta: { name: 'Old' } };
    const renamed = migrate(old, [
      (d) => {
        (d.meta as { name: string }).name = 'New';
        return d;
      },
    ]);
    expect(renamed.meta).toEqual({ name: 'New' });
    expect(old).toEqual({ format: FORMAT, version: 1, meta: { name: 'Old' } });
    expect(() =>
      migrate(old, [
        () => {
          throw new Error('bug');
        },
      ]),
    ).toThrow(/version: migrating from version 1 to 2 failed: bug/);
    const nested = `{"format":"mascotte","version":1,"x":${'['.repeat(1e5)}${']'.repeat(1e5)}}`;
    expect(() => readDocument(nested)).toThrow(/cannot be copied \(nested too deeply/);
    expect(() => migrate(old, [() => undefined as never])).toThrow(
      /version: migrating from version 1 to 2 gave no document\./,
    );
  });

  it('reads a JSON string and lists every problem in the error', () => {
    expect(readDocument(JSON.stringify(sample()))).toEqual(sample());
    const bad = broken((d) => {
      d.meta.name = '';
      d.layers[0].play = 'wave';
    });
    expect(() => readDocument(bad)).toThrow(
      /Invalid mascot document:\nmeta\.name: .*\nlayers\[0\]\.play: no motion "wave"/,
    );
  });
});

describe('buildDocument', () => {
  it('builds the tree, camera, rig and animation', () => {
    const built = buildDocument(readDocument(sample()));
    const scene = new Scene(built.root);
    const head = scene.getById('head') as Sphere;
    expect(head).toBeInstanceOf(Sphere);
    expect([head.diameter, head.style.color]).toEqual([40, '#f6a623']);
    expect(built.camera.zoom).toBe(2);
    expect(built.rig.node('head')).toBe(head);
    const animator = new Animator(scene, { rig: built.rig });
    const { machines, constraints } = built.animate(animator);
    expect(animator.layers.map((layer) => layer.name)).toEqual(['base', 'face']);
    expect(constraints.get('gaze')?.kind).toBe('aim');
    animator.update(0.5);
    expect(head.position.y).toBeCloseTo(5);
    animator.inputs.fire('poke');
    animator.update(0.1);
    expect(machines[0]?.state).toBe('nod');
  });

  it('plays blends of named and inline motions, on layers too, by inputs any machine declares', () => {
    const document = broken((d) => {
      const lift = {
        duration: 1,
        loop: 'once',
        tracks: [
          {
            target: 'head',
            property: 'position',
            keys: [{ time: 0, value: { x: 0, y: -20, z: 0 } }],
          },
        ],
      };
      d.motions.lean = {
        input: 'x',
        blend: [
          { at: 0, motion: 'nod' },
          { at: 1, motion: lift },
        ],
      };
      d.layers[0].play = 'lean';
      d.machines[0].inputs.push({ name: 'x', type: 'number' });
    });
    const built = buildDocument(readDocument(document));
    const scene = new Scene(built.root);
    const animator = new Animator(scene, { rig: built.rig });
    built.animate(animator);
    const head = scene.getById('head') as Sphere;
    animator.inputs.set('x', 1);
    animator.update(0.5);
    expect(head.position.y).toBeCloseTo(-20);
    animator.inputs.set('x', 0.5);
    animator.update(0);
    // Half way between the nod at 0.5 s (5) and the lift (−20).
    expect(head.position.y).toBeCloseTo(-7.5);
  });

  it('sets up layers as the document gives them and names constraints', () => {
    const built = buildDocument(
      readDocument(
        broken((d) => {
          d.layers[1] = { name: 'face', mode: 'additive', weight: 0.5, mask: { slot: 'head' } };
        }),
      ),
    );
    const animator = new Animator(new Scene(built.root), { rig: built.rig });
    const { constraints } = built.animate(animator);
    const face = animator.layers[1];
    expect([face?.name, face?.mode, face?.weight]).toEqual(['face', 'additive', 0.5]);
    expect(constraints.get('gaze')).toBe(animator.constraints[0]);
    expect(animator.springs).toHaveLength(1);
  });

  it('resolves names only among the motions, and leaves nested blends to the engine', () => {
    const animator = new Animator(new Scene(new Node()));
    expect(() => animateDocument({ layers: [{ name: 'a', play: 'toString' }] }, animator)).toThrow(
      /layers\[0\]\.play: no motion "toString" in motions\./,
    );
    const loop = {
      a: { input: 'x', blend: [{ at: 0, motion: 'b' }] },
      b: { input: 'x', blend: [{ at: 0, motion: 'a' }] },
    };
    const withInput = new Animator(new Scene(new Node()));
    withInput.inputs.define({ name: 'x', type: 'number' });
    expect(() =>
      animateDocument({ motions: loop, layers: [{ name: 'l', play: 'a' }] }, withInput),
    ).toThrow(/layers\[0\]\.play: .*blends do not nest/);
  });

  it('reports what the engine rejects at the path of the entry', () => {
    const fail = (change: (document: Loose) => void) => {
      try {
        const built = buildDocument(readDocument(broken(change)));
        built.animate(new Animator(new Scene(built.root), { rig: built.rig }));
      } catch (error) {
        expect(error).toBeInstanceOf(DocumentError);
        return (error as DocumentError).issues.map((issue) => `${issue.path}: ${issue.message}`);
      }
      return [];
    };
    expect(fail((d) => (d.motions.nod.tracks[0].target = { slot: 'tail' }))).toEqual([
      expect.stringMatching(/^layers\[0\]\.play: .*tail/),
    ]);
    expect(fail((d) => (d.machines[0].transitions[0].to = 'hop'))).toEqual([
      expect.stringMatching(/^machines\[0\]: .*hop/),
    ]);
    expect(fail((d) => (d.layers[1].mask = { slot: 'tail' }))).toEqual([
      expect.stringMatching(/^layers\[1\]: .*tail/),
    ]);
    expect(fail((d) => (d.constraints[0].target = { slot: 'tail' }))).toEqual([
      expect.stringMatching(/^constraints\[0\]: .*tail/),
    ]);
    expect(fail((d) => (d.springs[0].frequency = -1))).toEqual([
      expect.stringMatching(/^springs\[0\]: .*frequency/),
    ]);
  });
});

describe('writeNode', () => {
  it('writes types, set ids, changed properties, paths and faces, and reads them back', () => {
    const root = new Node({ id: 'root', name: 'Root' });
    root.add(new Sphere({ diameter: 10, position: { x: 1, y: 2, z: 3 } }));
    root.add(
      new PathShape({
        id: 'line',
        path: [
          { type: 'move', point: { x: 0, y: 0, z: 0 } },
          { type: 'line', point: { x: 5, y: 0, z: 0 } },
        ],
        closed: false,
        style: { stroke: 3 },
      }),
    );
    root.add(new Box({ id: 'box', width: 4, faces: { top: { visible: false } } }));
    root.add(new Cylinder({ id: 'can', frontFaceColor: '#ff0000' }));
    root.add(new Ellipse({ id: 'ring', quarters: 2, sortMode: 'attached' }));
    const written = writeNode(root);
    expect(written).toMatchObject({
      type: 'Node',
      id: 'root',
      name: 'Root',
      children: [
        { type: 'Sphere', props: { diameter: 10, position: { x: 1, y: 2, z: 3 } } },
        { type: 'PathShape', id: 'line', props: { 'style.stroke': 3 } },
        {
          type: 'Box',
          id: 'box',
          props: { width: 4 },
          faces: { top: { visible: false, color: null } },
        },
        { type: 'Cylinder', id: 'can', props: { frontFaceColor: '#ff0000' } },
        { type: 'Ellipse', id: 'ring', props: { quarters: 2, sortMode: 'attached' } },
      ],
    });
    // A generated id and default values are not written; parts a solid made are left out.
    expect(written.children?.[0]).not.toHaveProperty('id');
    expect(written.children?.[2]).not.toHaveProperty('children');
    expect(written.props).toBeUndefined();
    const again = buildDocument(
      readDocument({ ...sample(), root: written, rig: {}, constraints: [], springs: [] }),
    );
    expect(writeNode(again.root)).toEqual(written);
  });

  it('round-trips every node type with every property it has', async () => {
    const { propertiesOf, Capsule, Cone, Hemisphere, Polygon, Rect, RoundedRect } = await import(
      '@mascotte/engine'
    );
    const root = new Node({ id: 'root' });
    for (const type of [
      Ellipse,
      Rect,
      RoundedRect,
      Polygon,
      PathShape,
      Sphere,
      Capsule,
      Hemisphere,
      Cylinder,
      Cone,
      Box,
    ]) {
      root.add(
        new type({
          id: type.typeName,
          position: { x: 1, y: 2, z: 3 },
          opacity: 0.5,
          style: { color: '#123456', stroke: 2 },
        }),
      );
    }
    const again = buildDocument(
      readDocument(
        JSON.parse(
          JSON.stringify({
            ...sample(),
            root: writeNode(root),
            rig: {},
            constraints: [],
            springs: [],
          }),
        ),
      ),
    );
    const vec = { x: 0, y: 0, z: 0, w: 0 };
    const read = (node: Node) =>
      propertiesOf(node).map((p) => [
        p.name,
        p.type === 'vec3' || p.type === 'quat' ? { ...p.get(node, { ...vec }) } : p.get(node),
      ]);
    root.children.forEach((child, i) => {
      const copy = again.root.children[i] as Node;
      expect(copy.constructor).toBe(child.constructor);
      expect(read(copy)).toEqual(read(child));
      // The parts a solid makes are made again, not stored.
      expect(copy.children.length).toBe(child.children.length);
    });
  });

  it('refuses values a document cannot hold and nodes added under a solid part', () => {
    const far = new Node({ id: 'far', zBias: Number.POSITIVE_INFINITY });
    expect(() => writeNode(far)).toThrow(/far: zBias = .* cannot be stored/);
    const named = new Ellipse({ id: 'named', style: { color: 'red' } });
    expect(() => writeNode(named)).toThrow(/named: style\.color = "red" cannot be stored/);
    const can = new Cylinder({ id: 'can' });
    can.frontBase.add(new Ellipse({ id: 'label' }));
    const skewed = new Node({ id: 'skewed' });
    skewed.rotation.set(0, 0, 0, 2);
    expect(() => writeNode(skewed)).toThrow(/skewed: rotation = .* cannot be stored/);
    const deep = new Node({ id: 'top' });
    let tip = deep;
    for (let i = 0; i <= MAX_DEPTH; i++) tip = tip.add(new Node()).children[0] as Node;
    expect(() => writeNode(deep)).toThrow(new RegExp(`deeper than ${MAX_DEPTH} levels`));
    expect(() => writeNode(can)).toThrow(/can\/front.* is a part can makes/);
  });

  it('refuses a node type a document cannot make', () => {
    class Star extends Node {
      static override readonly typeName: string = 'Star';
    }
    expect(() => writeNode(new Star())).toThrow(/cannot hold a node of type Star/);
  });
});
