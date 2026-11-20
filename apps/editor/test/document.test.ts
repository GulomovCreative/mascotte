import { type MascotDocument, type NodeDocument, readDocument } from '@mascotte/format';
import { gloopDocument, misoDocument, pipDocument } from '@mascotte/reference';
import { describe, expect, it } from 'vitest';
import {
  addNode,
  duplicateNode,
  extractPrefab,
  moveNode,
  removeNode,
  renameNode,
  setDocumentField,
  setName,
  setNodeField,
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
      const before = editor.state.document;
      editor.execute(command);
      editor.commit();
      const after = editor.state.document;
      expect(after).not.toBe(before);
      editor.undo();
      expect(editor.state.document).toEqual(before);
      editor.redo();
      expect(editor.state.document).toEqual(after);
    }
    // All the way back.
    while (editor.state.canUndo) editor.undo();
    expect(editor.state.document).toEqual(make());
  });

  it('merges a drag into one step until it is committed', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    const start = editor.state.document;
    for (const x of [1, 2, 3]) editor.execute(setProp([0], 'position', { x, y: 0, z: 0 }));
    editor.commit();
    editor.execute(setProp([0], 'position', { x: 9, y: 0, z: 0 }));
    editor.undo();
    expect(nodeAt(editor.state.document, [0])?.props?.position).toEqual({ x: 3, y: 0, z: 0 });
    editor.undo();
    expect(editor.state.document).toEqual(start);
    expect(editor.state.canUndo).toBe(false);
  });

  it('makes ids unique against the expanded tree', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    const taken = expandedIds(editor.state.document);
    // A prefab instance's nodes are `eye-left-white`, `eye-left-pupil`, …: not to be met.
    expect(taken.has('eye-left-pupil')).toBe(true);
    editor.execute(addNode([], { type: 'Sphere', id: 'eye-left-pupil' }));
    const added = nodeAt(editor.state.document, editor.state.selection ?? [])?.id;
    expect(added).toBe('eye-left-pupil-2');
    editor.execute(addNode([], { type: 'Sphere' }));
    expect(nodeAt(editor.state.document, editor.state.selection ?? [])?.id).toBe('sphere');
    expect(editor.state.issues).toEqual([]);
  });

  it('renames every reference with the id, the ids a prefab instance makes too', () => {
    const pip = new EditorDocument(readDocument(pipDocument()));
    pip.execute(renameNode(pathOf(pip.state.document, 'beak-lower'), 'jaw'));
    expect(pip.state.document.rig?.slots?.['beak.lower']).toBe('jaw');
    expect(pip.state.issues).toEqual([]);
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
    expect(editor.state.issues).toEqual([]);
    editor.execute(renameNode(pathOf(named, 'eye-left'), 'eye-l'));
    const document = editor.state.document;
    const look = document.motions?.look as unknown as { tracks: { target: unknown }[] } | undefined;
    const track = look?.tracks[0];
    expect(track?.target).toBe('eye-l-pupil');
    expect(document.layers?.at(-1)?.mask).toBe('eye-l');
    expect(document.constraints?.[0]?.target).toBe('eye-l');
    expect(document.springs?.[0]?.target).toBe('eye-l-pupil');
    expect(editor.state.issues).toEqual([]);
  });

  it('keeps the last scene that built while the document has issues', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    const good = editor.state.scene;
    expect(editor.state.stale).toBe(false);
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
    expect(editor.state.issues.length).toBeGreaterThan(0);
    expect(editor.state.scene).toBe(good);
    expect(editor.state.stale).toBe(true);
    editor.undo();
    expect(editor.state.issues).toEqual([]);
    expect(editor.state.stale).toBe(false);
  });

  it('refuses to remove the root or move a node into itself, and follows the selection', () => {
    const editor = new EditorDocument(readDocument(gloopDocument));
    expect(() => editor.execute(removeNode([]))).toThrow(RangeError);
    expect(() => editor.execute(moveNode([1], [1, 0], 0))).toThrow(/into itself/);
    editor.select([1, 0, 0]);
    editor.execute(moveNode([1], [], 0));
    expect(editor.state.selection).toEqual([0, 0, 0]);
    editor.execute(removeNode([0]));
    expect(editor.state.selection).toBeNull();
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
    expect(editor.state.issues).toEqual([]);
    editor.select([2]);
    editor.execute(moveNode([0], [], 3));
    expect(ids(editor.state.document)).toEqual(['b', 'c', 'a', 'd']);
    // c moved from [2] to [1] as a went past it.
    expect(editor.state.selection).toEqual([1]);
    editor.execute(moveNode([3], [], 0));
    expect(ids(editor.state.document)).toEqual(['d', 'b', 'c', 'a']);
    expect(editor.state.selection).toEqual([2]);
    editor.execute(moveNode([0], [], 99));
    expect(ids(editor.state.document)).toEqual(['b', 'c', 'a', 'd']);
    expect(() => editor.execute(moveNode([0], [], 0.5))).toThrow(/integer/);
  });

  it('moves into a later sibling, and removes the last child and the last property', () => {
    const editor = new EditorDocument(flat('a', 'b', 'c'));
    editor.select([0]);
    editor.execute(moveNode([0], [2], 0));
    expect(ids(editor.state.document)).toEqual(['b', 'c']);
    expect(ids(editor.state.document, [1])).toEqual(['a']);
    expect(editor.state.selection).toEqual([1, 0]);
    editor.execute(removeNode([1, 0]));
    expect('children' in (nodeAt(editor.state.document, [1]) ?? {})).toBe(false);
    expect(editor.state.selection).toBeNull();
    editor.select([1]);
    editor.execute(removeNode([0]));
    expect(editor.state.selection).toEqual([0]);
    editor.execute(setProp([0], 'visible', false));
    editor.execute(setProp([0], 'visible', undefined));
    expect('props' in (nodeAt(editor.state.document, [0]) ?? {})).toBe(false);
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
    expect(editor.state.canUndo).toBe(false);
  });

  it('starts a new step after an undo, clears redo with a new command, restores the selection', () => {
    const editor = new EditorDocument(flat('a', 'b'));
    editor.execute(setProp([0], 'position', { x: 1, y: 0, z: 0 }));
    editor.execute(setProp([0], 'position', { x: 2, y: 0, z: 0 }));
    editor.undo();
    editor.execute(setProp([0], 'position', { x: 3, y: 0, z: 0 }));
    editor.undo();
    expect(nodeAt(editor.state.document, [0])?.props).toBeUndefined();
    expect(editor.state.canRedo).toBe(true);
    editor.execute(setName([0], 'A'));
    expect(editor.state.canRedo).toBe(false);
    editor.select([1]);
    editor.execute(addNode([], { type: 'Node' }));
    expect(editor.state.selection).toEqual([2]);
    editor.undo();
    expect(editor.state.selection).toEqual([1]);
    // A path with no node selects nothing.
    editor.select([9]);
    expect(editor.state.selection).toBeNull();
  });

  it('duplicates a subtree with fresh ids, and renames to a free id', () => {
    const editor = new EditorDocument(flat('a', 'b'));
    editor.execute(addNode([0], { type: 'Node', id: 'leaf' }));
    editor.execute(duplicateNode([0]));
    expect(ids(editor.state.document)).toEqual(['a', 'a-2', 'b']);
    expect(ids(editor.state.document, [1])).toEqual(['leaf-2']);
    expect(editor.state.selection).toEqual([1]);
    editor.execute(renameNode([2], 'a'));
    expect(ids(editor.state.document)).toEqual(['a', 'a-2', 'a-3']);
    // Only what the format refuses is changed.
    editor.execute(renameNode([2], 'глаз левый'));
    expect(ids(editor.state.document)[2]).toBe('глаз левый');
    editor.execute(renameNode([2], '~x/y'));
    expect(ids(editor.state.document)[2]).toBe('x-y');
    expect(editor.state.issues).toEqual([]);
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
    expect(editor.state.issues).toEqual([]);
    editor.execute(renameNode([0], 'look'));
    expect(editor.state.document.springs?.map((spring) => spring.target)).toEqual([
      'peep-left-pupil',
      'look-pupil',
    ]);
    expect(editor.state.issues).toEqual([]);
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
    const text = JSON.stringify({ ...editor.state.document, root: null });
    expect(text).not.toContain('"a"');
    expect(editor.state.document.constraints?.[0]).toMatchObject({
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
    const good = editor.state.scene;
    editor.execute(renameNode([1], 'elsewhere'));
    editor.execute(setProp([1], 'visible', false));
    // Renamed with every reference, the document still builds: a new scene each time.
    expect(editor.state.stale).toBe(false);
    expect(editor.state.scene).not.toBe(good);
    const broken = new EditorDocument({
      ...readDocument(gloopDocument),
      layers: [{ name: 'x', play: 'none' }],
    });
    expect(broken.state.scene).toBeNull();
    expect(broken.state.stale).toBe(false);
    expect(broken.state.issues.length).toBeGreaterThan(0);
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

  it('picks an id under which the ids a prefab instance makes are free too', () => {
    const base = flat();
    const document: MascotDocument = {
      ...base,
      root: {
        type: 'Node',
        id: 'root',
        children: [
          { prefab: 'eye', id: 'eye' },
          { type: 'Node', id: 'foo-pupil' },
        ],
      },
    };
    const editor = new EditorDocument(document);
    expect(editor.state.issues).toEqual([]);
    // `foo` is free, but the eye would make `foo-pupil`, which is taken.
    editor.execute(renameNode([0], 'foo'));
    expect(nodeAt(editor.state.document, [0])?.id).toBe('foo-2');
    editor.execute(addNode([], { prefab: 'eye', id: 'foo' }));
    expect(nodeAt(editor.state.document, [2])?.id).toBe('foo-3');
    editor.execute(duplicateNode([2]));
    expect(nodeAt(editor.state.document, [3])?.id).toBe('foo-3-2');
    expect(editor.state.issues).toEqual([]);
  });

  it('destroys a scene once a newer one replaces it, and keeps it while the document is broken', () => {
    const editor = new EditorDocument(flat('a'));
    const first = editor.state.scene;
    editor.execute(setName([0], 'A'));
    expect(first?.scene.root.destroyed).toBe(true);
    const second = editor.state.scene;
    editor.execute(renameNode([0], 'b'));
    editor.execute({
      label: 'Break',
      run: (document) => ({ document: { ...document, layers: [{ name: 'x', play: 'none' }] } }),
    });
    expect(editor.state.stale).toBe(true);
    expect(editor.state.scene?.scene.root.destroyed).toBe(false);
    expect(second?.scene.root.destroyed).toBe(true);
  });

  it('notifies only when something changes, and throws a bug rather than report it', () => {
    const editor = new EditorDocument(flat('a'));
    let heard = 0;
    editor.subscribe(() => heard++);
    editor.select([0]);
    editor.select([0]);
    editor.execute(setName([0], ''));
    expect(heard).toBe(1);
    const before = editor.state;
    expect(() =>
      editor.execute({
        label: 'Bug',
        run: (document) => ({
          document: {
            ...document,
            get root(): never {
              throw new TypeError('a bug');
            },
          },
        }),
      }),
    ).toThrow(TypeError);
    expect(editor.state).toBe(before);
  });

  it('sets and removes the fields outside the tree, dropping what they leave empty', () => {
    const document = readDocument(gloopDocument);
    const editor = new EditorDocument(document);
    editor.execute(setDocumentField(['camera', 'props', 'projection'], 'perspective'));
    editor.execute(setDocumentField(['view', 'background'], undefined));
    editor.execute(setDocumentField(['meta', 'description'], undefined));
    editor.execute(setDocumentField(['archetype'], 'bird'));
    let next = editor.state.document;
    expect(next.camera?.props).toEqual({ zoom: 1.4, projection: 'perspective' });
    expect(next.view).toEqual({ width: 240, height: 240 });
    expect(next.meta).toEqual({ name: 'Gloop' });
    expect(next.archetype).toBe('bird');
    // The archetype's slots are not bound now: an issue, still edited.
    expect(editor.state.issues.length).toBeGreaterThan(0);
    // Removing the camera's last property removes the camera.
    editor.execute(setDocumentField(['camera', 'props', 'zoom'], undefined));
    editor.execute(setDocumentField(['camera', 'props', 'projection'], undefined));
    next = editor.state.document;
    expect('camera' in next).toBe(false);
    // The same value again is no step.
    const steps = editor.state.undoLabel;
    editor.execute(setDocumentField(['view', 'width'], 240));
    expect(editor.state.undoLabel).toBe(steps);
    for (let i = 0; i < 6; i++) editor.undo();
    expect(editor.state.document).toBe(document);
  });

  it('makes the objects a field needs, and refuses to remove a required field', () => {
    const { camera: _, ...document } = readDocument(gloopDocument);
    const editor = new EditorDocument(document);
    editor.execute(setDocumentField(['camera', 'props', 'zoom'], 2));
    expect(editor.state.document.camera).toEqual({ props: { zoom: 2 } });
    editor.undo();
    expect(editor.state.document).toBe(document);
    // Removing it again, once it is gone, is no step.
    editor.execute(setDocumentField(['view', 'background'], undefined));
    editor.execute(setDocumentField(['view', 'background'], undefined));
    expect(editor.state.undoLabel).toBe('Set view.background');
    editor.undo();
    expect(editor.state.canUndo).toBe(false);
    for (const field of [
      ['meta', 'name'],
      ['view', 'width'],
      ['view', 'height'],
    ] as const) {
      expect(() => editor.execute(setDocumentField(field, undefined))).toThrow(/cannot be removed/);
    }
    expect(editor.state.document).toBe(document);
  });

  it("sets and removes a node's path and faces, each change one step", () => {
    const document = readDocument(gloopDocument);
    const editor = new EditorDocument(document);
    const path = [0];
    const commands = [{ type: 'move', point: { x: 1 } }] as const;
    editor.execute(setNodeField(path, 'path', commands));
    expect(nodeAt(editor.state.document, path)?.path).toEqual(commands);
    // The same value again is no change: no document, no step.
    const set = editor.state.document;
    editor.commit();
    editor.execute(setNodeField(path, 'path', [{ type: 'move', point: { x: 1 } }]));
    expect(editor.state.document).toBe(set);
    editor.execute(setNodeField(path, 'faces', { top: { visible: false } }));
    editor.commit();
    editor.execute(setNodeField(path, 'path', undefined));
    expect(Object.hasOwn(nodeAt(editor.state.document, path) ?? {}, 'path')).toBe(false);
    expect(nodeAt(editor.state.document, path)?.faces).toEqual({ top: { visible: false } });
    editor.undo();
    expect(nodeAt(editor.state.document, path)?.path).toEqual(commands);
    editor.undo();
    editor.undo();
    expect(editor.state.document).toBe(document);
  });

  it('makes a subtree a prefab, keeping the expanded tree and what names its nodes', () => {
    const base = readDocument(gloopDocument);
    const ear: NodeDocument = {
      type: 'Node',
      id: 'ear',
      name: 'Ear',
      props: { position: { x: 1, y: 2, z: 3 }, opacity: 0.5 },
      children: [
        { type: 'Sphere', id: 'ear-tip', props: { diameter: { param: 'size' } } },
        { type: 'Sphere', id: 'dot', props: { diameter: 2 } },
      ],
    };
    const document: MascotDocument = {
      ...base,
      params: { ...base.params, size: { default: 10, min: 1 } },
      root: { ...base.root, children: [...(base.root.children ?? []), ear] },
      rig: { slots: { ...base.rig?.slots, spot: 'dot' } },
    };
    expect(check(document).issues).toEqual([]);
    const path = [(document.root.children?.length ?? 1) - 1];
    const editor = new EditorDocument(document);
    editor.execute(extractPrefab(path, 'earPrefab'));
    const next = editor.state.document;
    expect(nodeAt(next, path)).toEqual({
      prefab: 'earPrefab',
      id: 'ear',
      name: 'Ear',
      params: { size: { param: 'size' } },
      props: { position: { x: 1, y: 2, z: 3 } },
    });
    expect(next.prefabs?.earPrefab).toEqual({
      params: { size: { default: 10, min: 1 } },
      root: {
        type: 'Node',
        props: { opacity: 0.5 },
        children: [
          { type: 'Sphere', id: 'tip', props: { diameter: { param: 'size' } } },
          { type: 'Sphere', id: 'dot', props: { diameter: 2 } },
        ],
      },
    });
    // `dot` is `ear-dot` once the instance prefixes it, and the rig follows.
    expect(next.rig?.slots?.spot).toBe('ear-dot');
    expect(editor.state.issues).toEqual([]);
    const ids = (made: MascotDocument) => [...expandedIds(made)].filter((id) => id !== 'dot');
    expect(new Set(ids(next))).toEqual(new Set([...ids(document), 'ear-dot']));
    expect(editor.state.selection).toEqual(path);
    editor.undo();
    expect(editor.state.document).toBe(document);
  });

  it('refuses to make a prefab of the root, of a subtree with instances, or by a name taken', () => {
    const document = readDocument(misoDocument);
    const editor = new EditorDocument(document);
    expect(() => editor.execute(extractPrefab([], 'all'))).toThrow(/root/);
    expect(() => editor.execute(extractPrefab(pathOf(document, 'head'), 'head'))).toThrow(
      /instances/,
    );
    const tail = pathOf(document, 'tail');
    expect(() => editor.execute(extractPrefab(tail, 'catEar'))).toThrow(/taken/);
    expect(() => editor.execute(extractPrefab(tail, 'eye'))).toThrow(/taken/);
    expect(() => editor.execute(extractPrefab(tail, ' '))).toThrow(/name/);
    expect(editor.state.document).toBe(document);
  });
});
