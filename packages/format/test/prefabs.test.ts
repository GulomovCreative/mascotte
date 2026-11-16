import { type Node, type PathShape, Scene, type Sphere } from '@mascotte/engine';
import { PREFABS } from '@mascotte/library';
import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  FORMAT,
  type MascotDocument,
  type NodeDocument,
  readDocument,
  VERSION,
  validateDocument,
} from '../src/index.ts';
import { expandDocument } from '../src/prefabs.ts';

/** A document whose tree is `children` under a root, with `params` and `prefabs`. */
function doc(children: unknown[], extra: Record<string, unknown> = {}): MascotDocument {
  return {
    format: FORMAT,
    version: VERSION,
    meta: { name: 'Parts' },
    view: { width: 100, height: 100 },
    root: { type: 'Node', id: 'root', children: children as NodeDocument[] },
    ...extra,
  } as MascotDocument;
}

function issues(value: unknown, params?: Record<string, number>): string[] {
  return validateDocument(value, params).map((issue) => `${issue.path}: ${issue.message}`);
}

function sceneOf(document: MascotDocument, params?: Record<string, number>) {
  return new Scene(buildDocument(readDocument(document), params ? { params } : {}).root);
}

describe('prefabs', () => {
  it('every library prefab expands into a valid subtree', () => {
    for (const name of PREFABS.keys()) {
      expect(issues(doc([{ prefab: name, id: `a-${name}` }])), name).toEqual([]);
    }
  });

  it('expands an instance: ids prefixed, its props on the root, its children added', () => {
    const scene = sceneOf(
      doc([
        {
          prefab: 'eye',
          id: 'eye-left',
          params: { size: 20 },
          props: { position: { x: -10, y: 0, z: 30 } },
          children: [{ type: 'Node', id: 'lid' }],
        },
      ]),
    );
    const eye = scene.getById('eye-left') as Node;
    expect(eye.position.x).toBe(-10);
    expect((scene.getById('eye-left-white') as Sphere).diameter).toBe(20);
    expect((scene.getById('eye-left-pupil') as Sphere).diameter).toBe(10);
    // A vector reference: (0, 0, 0.3) × size.
    expect(scene.getById('eye-left-iris')?.position.z).toBeCloseTo(6);
    // The instance's own children first: they keep their paths in the document.
    expect(eye.children.map((child) => child.id)).toEqual([
      'lid',
      'eye-left-white',
      'eye-left-iris',
    ]);
  });

  it('document parameters drive instances, and building sets them again: one document, a family', () => {
    const family = doc(
      [
        { prefab: 'eye', id: 'eye-left', params: { size: { param: 'eyes' } } },
        { prefab: 'eye', id: 'eye-right', params: { size: { param: 'eyes', times: 1, plus: 2 } } },
        {
          prefab: 'mouth',
          id: 'mouth',
          params: { width: { param: 'eyes', times: 1.5 }, depth: 4 },
        },
      ],
      { params: { eyes: { default: 12, min: 4, max: 30 } } },
    );
    const white = (scene: Scene, id: string) => (scene.getById(id) as Sphere).diameter;
    const small = sceneOf(family);
    expect([white(small, 'eye-left-white'), white(small, 'eye-right-white')]).toEqual([12, 14]);
    const big = sceneOf(family, { eyes: 24 });
    expect([white(big, 'eye-left-white'), white(big, 'eye-right-white')]).toEqual([24, 26]);
    // The mouth's controls: across by its width (36), down by its depth (4).
    const path = (big.getById('mouth') as PathShape).path;
    expect(path[1]).toMatchObject({
      control1: { x: -9, y: 16 / 3, z: 0 },
      control2: { x: 9, y: 16 / 3, z: 0 },
      point: { x: 18, y: 0, z: 0 },
    });
    expect(() => sceneOf(family, { eyes: 40 })).toThrow(
      /params \(given\)\.eyes: expected at most 30, got 40\./,
    );
    expect(() => sceneOf(family, { mouths: 1 })).toThrow(
      /params \(given\)\.mouths: no parameter "mouths" \(there are eyes\)\./,
    );
  });

  it('a document may define its own prefabs, and a rig binds the ids they make', () => {
    const own = doc([{ prefab: 'whisker', id: 'w', params: { length: 9 } }], {
      prefabs: {
        whisker: {
          params: { length: { default: 5, min: 1 } },
          root: {
            type: 'PathShape',
            id: 'line',
            path: [
              { type: 'move', point: { x: 0, y: 0, z: 0 } },
              { type: 'line', point: { param: 'length', times: { x: 1, y: 0, z: 0 } } },
            ],
          },
        },
      },
      rig: { slots: { whisker: 'w' } },
    });
    const built = buildDocument(readDocument(own));
    expect(built.rig.node('whisker')?.id).toBe('w');
    expect((built.root.children[0] as PathShape).path[1]).toEqual({
      type: 'line',
      point: { x: 9, y: 0, z: 0 },
    });
  });

  it('reports what is wrong with prefabs, parameters and references, with paths', () => {
    expect(
      issues(
        doc(
          [
            { prefab: 'tail', id: 't' },
            { prefab: 'eye' },
            { prefab: 'eye', id: 'e', type: 'Sphere', params: { size: 1, colour: 3 } },
            { type: 'Sphere', props: { diameter: { param: 'girth' } } },
            { type: 'Sphere', props: { diameter: { param: 'size', times: { x: 1, y: 1, z: 1 } } } },
            { type: 'Node', props: { position: { param: 'size' } } },
            { prefab: 'bad', id: 'b' },
          ],
          {
            params: { size: { default: 3, max: 2, step: 1 } },
            prefabs: {
              bad: { root: { type: 'Node', children: [{ prefab: 'eye', id: 'inner' }] } },
            },
          },
        ),
      ),
    ).toEqual([
      'params.size.step: unknown field (expected one of default, min, max, description).',
      'params.size.default: expected at most 2, got 3.',
      'prefabs.bad.root.children[0]: a prefab cannot hold prefabs.',
      expect.stringMatching(
        /^root\.children\[0\]\.prefab: no prefab "tail" \(there are eye, mouth, ear, paw, bad\)\.$/,
      ),
      'root.children[1].id: a prefab instance needs an id, to name the ids of its nodes.',
      'root.children[2].type: a prefab instance has no type: its prefab does.',
      'root.children[2].params.size: expected at least 2, got 1.',
      'root.children[2].params.colour: no parameter "colour" (there are size).',
      'root.children[3].props.diameter.param: no parameter "girth" here (there are size).',
      // A vector where a number goes, and a number where a vector goes, reach the node checks.
      'root.children[4].props.diameter: expected a finite number, got {"x":3,"y":3,"z":3}.',
      'root.children[5].props.position: expected an object with x, y, z, got 3.',
      expect.stringMatching(/^root\.children\[6\]\.children\[0\]\.type: expected one of Node/),
    ]);
  });

  it('builds the document as written: readDocument keeps prefabs and parameters', () => {
    const written = doc([{ prefab: 'paw', id: 'paw' }], { params: { k: { default: 1 } } });
    const read = readDocument(JSON.stringify(written));
    expect(read.root.children?.[0]).toEqual({ prefab: 'paw', id: 'paw' });
    expect(read.params).toEqual({ k: { default: 1 } });
  });

  it('the library prefabs keep every {x, y, z} numeric, expanded or not', () => {
    // A reference inside {x, y, z} would make engine vectors box their numbers (see VectorRef).
    const bad: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (['x', 'y', 'z'].some((axis) => axis in record)) {
          for (const axis of ['x', 'y', 'z']) {
            if (typeof record[axis] !== 'number') bad.push(`${path}.${axis}`);
          }
        }
        for (const [key, item] of Object.entries(record)) walk(item, `${path}.${key}`);
      }
    };
    for (const [name, prefab] of PREFABS) {
      walk(prefab.root, name);
      const big = Object.fromEntries(
        Object.entries(prefab.params).map(([key, spec]) => [key, spec.max ?? spec.default * 2]),
      );
      const expanded = expandDocument(doc([{ prefab: name, id: 'p', params: big }]));
      expect(expanded.issues, name).toEqual([]);
      walk(expanded.document, `${name} expanded`);
    }
    expect(bad).toEqual([]);
  });

  it('refuses a reference inside {x, y, z}', () => {
    expect(
      issues(
        doc([{ type: 'Node', props: { position: { x: { param: 'k' }, y: 0, z: 0 } } }], {
          params: { k: { default: 1 } },
        }),
      ),
    ).toEqual([
      'root.children[0].props.position.x: a reference stands for a whole value, not one coordinate: use vector times and plus.',
    ]);
  });

  it('ear, paw and mouth follow their parameters', () => {
    const scene = sceneOf(
      doc([
        { prefab: 'ear', id: 'ear', params: { length: 20, width: 6 } },
        { prefab: 'paw', id: 'paw', params: { size: 12 } },
        { prefab: 'mouth', id: 'mouth', params: { stroke: 2 } },
      ]),
    );
    const ear = scene.getById('ear') as PathShape;
    expect(ear.path[1]).toEqual({ type: 'line', point: { x: 0, y: -20, z: 0 } });
    expect(ear.style.stroke).toBe(6);
    expect((scene.getById('paw') as Sphere).diameter).toBe(12);
    expect((scene.getById('mouth') as PathShape).style.stroke).toBe(2);
  });

  it('merges the instance props over the prefab root, and catches ids made twice', () => {
    const scene = sceneOf(
      doc([
        {
          prefab: 'paw',
          id: 'p',
          params: { size: 12 },
          props: { position: { x: 5, y: 0, z: 0 }, 'style.color': '#000000' },
        },
      ]),
    );
    const paw = scene.getById('p') as Sphere;
    expect([paw.diameter, paw.style.color, paw.position.x]).toEqual([12, '#000000', 5]);
    expect(
      issues(
        doc([
          { prefab: 'eye', id: 'e' },
          { type: 'Node', id: 'e-white' },
        ]),
      ),
    ).toEqual([expect.stringMatching(/the id "e-white" is used twice\./)]);
  });

  it('expands instance children in the document scope, prefabs among them too', () => {
    const scene = sceneOf(
      doc([{ prefab: 'eye', id: 'e', children: [{ prefab: 'paw', id: 'p' }] }]),
    );
    expect(scene.getById('p')?.parent?.id).toBe('e');
    // A child of an instance cannot see the prefab's parameters.
    expect(
      issues(
        doc([
          {
            prefab: 'eye',
            id: 'e',
            children: [{ type: 'Sphere', props: { diameter: { param: 'size' } } }],
          },
        ]),
      ),
    ).toEqual([
      'root.children[0].children[0].props.diameter.param: no parameter "size" here (there are none).',
    ]);
  });

  it('reports bad references, roots and depths without throwing', () => {
    const table: [unknown, RegExp][] = [
      [
        { param: 'k', times: 2, plus: { x: 1, y: 0, z: 0 } },
        /times and plus must both be numbers or both be vectors/,
      ],
      [{ param: 'k', scale: 2 }, /\.scale: unknown field \(expected one of param, times, plus\)/],
      [{ param: 'k', times: 'x' }, /\.times: expected a finite number or a vector/],
      [{ param: 'k', times: 1e308 }, /param × times \+ plus is not a finite number \(Infinity\)/],
    ];
    for (const [ref, message] of table) {
      const found = issues(
        doc([{ type: 'Sphere', props: { diameter: ref } }], { params: { k: { default: 10 } } }),
      );
      expect(found.join('\n'), JSON.stringify(ref)).toMatch(message);
    }
    expect(
      issues(
        doc(
          [
            {
              prefab: 'eye',
              id: 'e',
              params: { size: { param: 'k', times: { x: 1, y: 1, z: 1 } } },
            },
          ],
          {
            params: { k: { default: 10 } },
          },
        ),
      ),
    ).toEqual([
      'root.children[0].params.size: expected a finite number, got {"x":10,"y":10,"z":10}.',
    ]);
    expect(
      issues(
        doc([{ prefab: 'p', id: 'a' }], {
          prefabs: { p: { params: { s: { default: 1 } }, root: { param: 's' } } },
        }),
      ),
    ).toEqual([
      'prefabs.p: expected a prefab {params, root} whose root is a node.',
      expect.stringMatching(/no prefab "p"/),
    ]);
    expect(issues(doc([{ type: 'Node', params: { k: 1 } }]))).toEqual([
      'root.children[0].params: only a prefab instance has params.',
    ]);
    expect(issues(doc([{ prefab: 'paw', id: 'p', path: [] }]))).toEqual([
      'root.children[0].path: a prefab instance has no path: its prefab does.',
    ]);
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(issues(doc([{ type: 'Node', props: { opacity: deep } }])).join()).toMatch(
      /nested deeper than 64 levels/,
    );
  });

  it('checks a document prefab once, whether or not it is used', () => {
    const prefabs = { p: { root: { type: 'Sphere', props: { diameter: { param: 'nope' } } } } };
    expect(issues(doc([], { prefabs }))).toEqual([
      'prefabs.p.root.props.diameter.param: no parameter "nope" here (there are none).',
    ]);
    expect(
      issues(
        doc(
          [
            { prefab: 'p', id: 'a' },
            { prefab: 'p', id: 'b' },
          ],
          { prefabs },
        ),
      ),
    ).toHaveLength(1);
  });
});
