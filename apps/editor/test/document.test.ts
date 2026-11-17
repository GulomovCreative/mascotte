import { type MascotDocument, type NodeDocument, readDocument } from '@mascotte/format';
import { gloopDocument, misoDocument, pipDocument } from '@mascotte/reference';
import { describe, expect, it } from 'vitest';
import {
  addNode,
  duplicateNode,
  moveNode,
  removeNode,
  renameNode,
  setName,
  setProp,
} from '../src/model/commands.ts';
import { check, EditorDocument } from '../src/model/editor-document.ts';
import { expandedIds } from '../src/model/ids.ts';
import { nodeAt } from '../src/model/paths.ts';

const mascots: [string, () => MascotDocument][] = [
  ['pip', () => readDocument(pipDocument())],
  ['gloop', () => readDocument(gloopDocument)],
  ['miso', () => readDocument(misoDocument)],
];

/** The path of the first node with `id` written in the document. */
function pathOf(document: MascotDocument, id: string): number[] {
  const walk = (node: NodeDocument, path: number[]): number[] | null => {
    if (node.id === id) return path;
    for (const [i, child] of (node.children ?? []).entries()) {
      const found = walk(child, [...path, i]);
      if (found) return found;
    }
    return null;
  };
  const found = walk(document.root, []);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe('editor document', () => {
  it.each(mascots)('maps every node of %s to the document node it came from', (_, make) => {
    const document = make();
    const { issues, scene } = check(document);
    expect(issues).toEqual([]);
    if (!scene) throw new Error('no scene');
    let nodes = 0;
    scene.built.root.traverse((node) => {
      nodes++;
      const path = scene.sources.get(node);
      expect(path, node.id).toBeDefined();
      expect(nodeAt(document, path ?? []), node.id).not.toBeNull();
      // A node written in the document maps to itself.
      const source = nodeAt(document, path ?? []);
      if (source?.id !== undefined && source.prefab === undefined && node.owner === null) {
        expect(node.id).toBe(source.id);
      }
    });
    expect(nodes).toBe(scene.sources.size);
  });

  it('maps the nodes a prefab makes to its instance', () => {
    const document = readDocument(gloopDocument);
    const scene = check(document).scene;
    const pupil = scene?.scene.getById('eye-left-pupil');
    if (!scene || !pupil) throw new Error('no pupil');
    const instance = nodeAt(document, scene.sources.get(pupil) ?? []);
    expect([instance?.prefab, instance?.id]).toEqual(['eye', 'eye-left']);
  });

  it.each(mascots)('undoes every command on %s to the same document, and redoes it', (_, make) => {
    const editor = new EditorDocument(make());
    const commands = [
      setProp([0], 'position', { x: 1, y: 2, z: 3 }),
      setName([0], 'Ground'),
      addNode([], { type: 'Sphere', props: { diameter: 10 } }),
      duplicateNode([0]),
      moveNode([0], [1], 0),
      removeNode([1]),
    ];
    for (const command of commands) {
      const before = editor.document;
      editor.execute(command);
      editor.commit();
      const after = editor.document;
      expect(after).not.toBe(before);
      editor.undo();
      expect(editor.document).toEqual(before);
      editor.redo();
      expect(editor.document).toEqual(after);
    }
    // All the way back.
    while (editor.canUndo) editor.undo();
    expect(editor.document).toEqual(make());
  });

  it('merges a drag into one step until it is committed', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    const start = editor.document;
    for (const x of [1, 2, 3]) editor.execute(setProp([0], 'position', { x, y: 0, z: 0 }));
    editor.commit();
    editor.execute(setProp([0], 'position', { x: 9, y: 0, z: 0 }));
    editor.undo();
    expect(nodeAt(editor.document, [0])?.props?.position).toEqual({ x: 3, y: 0, z: 0 });
    editor.undo();
    expect(editor.document).toEqual(start);
    expect(editor.canUndo).toBe(false);
  });

  it('makes ids unique against the expanded tree', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    const taken = expandedIds(editor.document);
    // A prefab instance's nodes are `eye-left-white`, `eye-left-pupil`, …: not to be met.
    expect(taken.has('eye-left-pupil')).toBe(true);
    editor.execute(addNode([], { type: 'Sphere', id: 'eye-left-pupil' }));
    const added = nodeAt(editor.document, editor.selection ?? [])?.id;
    expect(added).toBe('eye-left-pupil-2');
    editor.execute(addNode([], { type: 'Sphere' }));
    expect(nodeAt(editor.document, editor.selection ?? [])?.id).toBe('sphere');
    expect(editor.issues).toEqual([]);
  });

  it('renames every reference with the id, the ids a prefab instance makes too', () => {
    const pip = new EditorDocument(readDocument(pipDocument()));
    pip.execute(renameNode(pathOf(pip.document, 'beak-lower'), 'jaw'));
    expect(pip.document.rig?.slots?.['beak.lower']).toBe('jaw');
    expect(pip.issues).toEqual([]);
    // A document naming nodes by id everywhere it can.
    const base = readDocument(gloopDocument);
    const named: MascotDocument = {
      ...base,
      motions: {
        ...base.motions,
        look: {
          duration: 1,
          loop: 'loop',
          tracks: [
            {
              target: 'eye-left-pupil',
              property: 'position',
              keys: [{ time: 0, value: { x: 0, y: 0, z: 0 } }],
            },
          ],
        },
      },
      layers: [...(base.layers ?? []), { name: 'look', play: 'look', mask: 'eye-left' }],
      constraints: [{ kind: 'aim', target: 'eye-left', name: 'gaze' }],
      springs: [{ target: 'eye-left-pupil', tip: { x: 0, y: 0, z: 1 } }],
    };
    const editor = new EditorDocument(named);
    expect(editor.issues).toEqual([]);
    editor.execute(renameNode(pathOf(named, 'eye-left'), 'eye-l'));
    const document = editor.document;
    const look = document.motions?.look as unknown as { tracks: { target: unknown }[] } | undefined;
    const track = look?.tracks[0];
    expect(track?.target).toBe('eye-l-pupil');
    expect(document.layers?.at(-1)?.mask).toBe('eye-l');
    expect(document.constraints?.[0]?.target).toBe('eye-l');
    expect(document.springs?.[0]?.target).toBe('eye-l-pupil');
    expect(editor.issues).toEqual([]);
  });

  it('keeps the last scene that built while the document has issues', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    const good = editor.scene;
    expect(editor.stale).toBe(false);
    // A track only the engine checks: the trial animation reports it.
    editor.execute({
      label: 'Break a motion',
      run: (document) => ({
        document: {
          ...document,
          motions: {
            ...document.motions,
            bad: {
              duration: 1,
              tracks: [{ target: 'blob', property: 'nonsense', keys: [{ time: 0, value: 1 }] }],
            } as never,
          },
          layers: [...(document.layers ?? []), { name: 'bad', play: 'bad' }],
        },
      }),
    });
    expect(editor.issues.length).toBeGreaterThan(0);
    expect(editor.scene).toBe(good);
    expect(editor.stale).toBe(true);
    editor.undo();
    expect(editor.issues).toEqual([]);
    expect(editor.stale).toBe(false);
  });

  it('refuses to remove the root or move a node into itself, and follows the selection', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    expect(() => editor.execute(removeNode([]))).toThrow(RangeError);
    expect(() => editor.execute(moveNode([1], [1, 0], 0))).toThrow(/into itself/);
    editor.select([1, 0, 0]);
    editor.execute(moveNode([1], [], 0));
    expect(editor.selection).toEqual([0, 0, 0]);
    editor.execute(removeNode([0]));
    expect(editor.selection).toBeNull();
  });

  /** A document whose root holds plain nodes with ids `ids`. */
  function flat(...ids: string[]): MascotDocument {
    const base = readDocument(gloopDocument);
    return {
      ...base,
      archetype: undefined as never,
      rig: { slots: {} },
      motions: {},
      layers: [],
      machines: [],
      constraints: [],
      springs: [],
      root: { type: 'Node', id: 'root', children: ids.map((id) => ({ type: 'Node', id })) },
    };
  }

  const ids = (document: MascotDocument, path: number[] = []) =>
    (nodeAt(document, path)?.children ?? []).map((child) => child.id);

  it('moves among siblings forwards, backwards and to the end, the selection following', () => {
    const editor = new EditorDocument(flat('a', 'b', 'c', 'd'));
    expect(editor.issues).toEqual([]);
    editor.select([2]);
    editor.execute(moveNode([0], [], 3));
    expect(ids(editor.document)).toEqual(['b', 'c', 'a', 'd']);
    // c moved from [2] to [1] as a went past it.
    expect(editor.selection).toEqual([1]);
    editor.execute(moveNode([3], [], 0));
    expect(ids(editor.document)).toEqual(['d', 'b', 'c', 'a']);
    expect(editor.selection).toEqual([2]);
    editor.execute(moveNode([0], [], 99));
    expect(ids(editor.document)).toEqual(['b', 'c', 'a', 'd']);
    expect(() => editor.execute(moveNode([0], [], 0.5))).toThrow(/integer/);
  });

  it('moves into a later sibling, and removes the last child and the last property', () => {
    const editor = new EditorDocument(flat('a', 'b', 'c'));
    editor.select([0]);
    editor.execute(moveNode([0], [2], 0));
    expect(ids(editor.document)).toEqual(['b', 'c']);
    expect(ids(editor.document, [1])).toEqual(['a']);
    expect(editor.selection).toEqual([1, 0]);
    editor.execute(removeNode([1, 0]));
    expect('children' in (nodeAt(editor.document, [1]) ?? {})).toBe(false);
    expect(editor.selection).toBeNull();
    editor.select([1]);
    editor.execute(removeNode([0]));
    expect(editor.selection).toEqual([0]);
    editor.execute(setProp([0], 'visible', false));
    editor.execute(setProp([0], 'visible', undefined));
    expect('props' in (nodeAt(editor.document, [0]) ?? {})).toBe(false);
  });

  it('adds no step for a change that changes nothing', () => {
    const editor = new EditorDocument(flat('a'));
    editor.execute(setProp([0], 'visible', false));
    editor.commit();
    editor.execute(setProp([0], 'visible', false));
    editor.execute(setName([0], ''));
    editor.execute(renameNode([0], 'a'));
    editor.execute(renameNode([0], ' a '));
    editor.undo();
    expect(editor.canUndo).toBe(false);
  });

  it('starts a new step after an undo, clears redo with a new command, restores the selection', () => {
    const editor = new EditorDocument(flat('a', 'b'));
    editor.execute(setProp([0], 'position', { x: 1, y: 0, z: 0 }));
    editor.execute(setProp([0], 'position', { x: 2, y: 0, z: 0 }));
    editor.undo();
    editor.execute(setProp([0], 'position', { x: 3, y: 0, z: 0 }));
    editor.undo();
    expect(nodeAt(editor.document, [0])?.props).toBeUndefined();
    expect(editor.canRedo).toBe(true);
    editor.execute(setName([0], 'A'));
    expect(editor.canRedo).toBe(false);
    editor.select([1]);
    editor.execute(addNode([], { type: 'Node' }));
    expect(editor.selection).toEqual([2]);
    editor.undo();
    expect(editor.selection).toEqual([1]);
    // A path with no node selects nothing.
    editor.select([9]);
    expect(editor.selection).toBeNull();
  });

  it('duplicates a subtree with fresh ids, and renames to a free id', () => {
    const editor = new EditorDocument(flat('a', 'b'));
    editor.execute(addNode([0], { type: 'Node', id: 'leaf' }));
    editor.execute(duplicateNode([0]));
    expect(ids(editor.document)).toEqual(['a', 'a-2', 'b']);
    expect(ids(editor.document, [1])).toEqual(['leaf-2']);
    expect(editor.selection).toEqual([1]);
    editor.execute(renameNode([2], 'a'));
    expect(ids(editor.document)).toEqual(['a', 'a-2', 'a-3']);
    // Only what the format refuses is changed.
    editor.execute(renameNode([2], 'глаз левый'));
    expect(ids(editor.document)[2]).toBe('глаз левый');
    editor.execute(renameNode([2], '~x/y'));
    expect(ids(editor.document)[2]).toBe('x-y');
    expect(editor.issues).toEqual([]);
  });

  it('renames only the ids its own prefab instance makes', () => {
    const base = flat();
    const document: MascotDocument = {
      ...base,
      root: {
        type: 'Node',
        id: 'root',
        children: [
          { prefab: 'eye', id: 'peep' },
          { prefab: 'eye', id: 'peep-left' },
        ],
      },
      springs: [
        { target: 'peep-left-pupil', tip: { x: 0, y: 0, z: 1 } },
        { target: 'peep-pupil', tip: { x: 0, y: 0, z: 1 } },
      ],
    };
    const editor = new EditorDocument(document);
    expect(editor.issues).toEqual([]);
    editor.execute(renameNode([0], 'look'));
    expect(editor.document.springs?.map((spring) => spring.target)).toEqual([
      'peep-left-pupil',
      'look-pupil',
    ]);
    expect(editor.issues).toEqual([]);
  });

  it('renames the targets of behaviors, blends, states, layers and every constraint field', () => {
    const base = flat('a', 'b');
    const clip = (target: string) => ({
      duration: 1,
      tracks: [{ target, property: 'position', keys: [{ time: 0, value: { x: 0, y: 0, z: 0 } }] }],
    });
    const document = {
      ...base,
      motions: {
        wobble: {
          behaviors: [
            {
              kind: 'oscillate',
              target: 'a',
              property: 'position',
              from: { x: 0, y: 0, z: 0 },
              to: { x: 1, y: 0, z: 0 },
              period: 1,
            },
          ],
        },
        mix: { input: 'speed', blend: [{ at: 0, motion: clip('a') }] },
      },
      layers: [{ name: 'base', play: clip('a') }],
      machines: [
        {
          name: 'm',
          layer: 'base',
          inputs: [{ name: 'speed', type: 'number' }],
          states: [{ name: 's', motion: clip('a') }],
          transitions: [],
        },
      ],
      constraints: [{ kind: 'twoBoneIK', target: 'a', mid: 'a', at: 'a', pole: 'a' }],
    } as unknown as MascotDocument;
    const editor = new EditorDocument(document);
    editor.execute(renameNode([0], 'z'));
    const text = JSON.stringify({ ...editor.document, root: null });
    expect(text).not.toContain('"a"');
    expect(editor.document.constraints?.[0]).toMatchObject({
      target: 'z',
      mid: 'z',
      at: 'z',
      pole: 'z',
    });
  });

  it('maps the parts of a solid to the solid, and the nodes after it to themselves', () => {
    const base = flat();
    const document: MascotDocument = {
      ...base,
      root: {
        type: 'Node',
        id: 'root',
        children: [
          { type: 'Cylinder', id: 'can' },
          { type: 'Sphere', id: 'ball' },
        ],
      },
    };
    const scene = check(document).scene;
    if (!scene) throw new Error('no scene');
    const can = scene.scene.getById('can');
    let parts = 0;
    for (const child of can?.children ?? []) {
      if (child.owner === null) continue;
      parts++;
      expect(scene.sources.get(child)).toEqual([0]);
    }
    expect(parts).toBeGreaterThan(0);
    expect(scene.sources.get(scene.scene.getById('ball') as never)).toEqual([1]);
  });

  it('builds a new scene after each valid change, and starts with none when broken', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    const good = editor.scene;
    editor.execute(renameNode([1], 'elsewhere'));
    editor.execute(setProp([1], 'visible', false));
    // Renamed with every reference, the document still builds: a new scene each time.
    expect(editor.stale).toBe(false);
    expect(editor.scene).not.toBe(good);
    const broken = new EditorDocument({
      ...readDocument(gloopDocument),
      layers: [{ name: 'x', play: 'none' }],
    });
    expect(broken.scene).toBeNull();
    expect(broken.stale).toBe(false);
    expect(broken.issues.length).toBeGreaterThan(0);
  });

  it('runs every listener even when one throws, then throws its error', () => {
    const editor = new EditorDocument(flat('a'));
    const heard: string[] = [];
    editor.subscribe(() => {
      throw new Error('first');
    });
    editor.subscribe(() => heard.push('second'));
    expect(() => editor.select([0])).toThrow('first');
    expect(heard).toEqual(['second']);
    expect(editor.state.selection).toEqual([0]);
  });
});
