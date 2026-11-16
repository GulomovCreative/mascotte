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
    expect(eye.children.map((child) => child.id)).toEqual([
      'eye-left-white',
      'eye-left-iris',
      'lid',
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
      'root.children[2].type: a prefab instance has no type.',
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
});
