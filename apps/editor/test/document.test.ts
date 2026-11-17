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
    expect(() => removeNode([])).toThrow(RangeError);
    expect(() => editor.execute(moveNode([1], [1, 0], 0))).toThrow(/into itself/);
    editor.select([1, 0, 0]);
    editor.execute(moveNode([1], [], 0));
    expect(editor.selection).toEqual([0, 0, 0]);
    editor.execute(removeNode([0]));
    expect(editor.selection).toBeNull();
  });
});
