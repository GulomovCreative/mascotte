import type {
  MascotDocument,
  NodeDocument,
  PlainValue,
  PrefabDocument,
  PropertyValue,
  ShapeParam,
} from '@mascotte/format';
import { PREFABS } from '@mascotte/library';
import { expandedIds, madeSuffixes, uniqueId, withUniqueIds } from './ids.ts';
import { type DocPath, isWithin, nodeAt, pathString, samePath, updateNode } from './paths.ts';
import { renameReferences } from './references.ts';

/** What a command leaves: the new document, and the selection if it moves it. */
export interface CommandResult {
  readonly document: MascotDocument;
  /** The selection after it; left out, the selection stays. */
  readonly selection?: DocPath | null;
}

/**
 * A change to the document. The editor keeps the document before it, so undo is exact; commands
 * build new documents and never change the one they are given.
 */
export interface Command {
  readonly label: string;
  /**
   * Run one after another with the same key (a drag, a slider), commands merge into one undo
   * step until the editor commits the gesture.
   */
  readonly merge?: string;
  run(document: MascotDocument, selection: DocPath | null): CommandResult;
}

function existing(document: MascotDocument, path: DocPath): NodeDocument {
  const node = nodeAt(document, path);
  if (!node) throw new RangeError(`No node at ${pathString(path)}.`);
  return node;
}

/** Whether two stored values are the same (as JSON). */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Sets the property `name` of the node at `path`, or removes it (back to its default). */
export function setProp(path: DocPath, name: string, value: PropertyValue | undefined): Command {
  return {
    label: `Set ${name}`,
    merge: `prop ${pathString(path)} ${name}`,
    run: (document) => {
      // The same value: nothing to change, no step to undo.
      if (same(existing(document, path).props?.[name], value)) return { document };
      return {
        document: updateNode(document, path, (node) => {
          // Props that are no object (the format reports them) are replaced, not spread.
          const own = node.props;
          const { [name]: _, ...rest } =
            typeof own === 'object' && own !== null && !Array.isArray(own) ? own : {};
          const props = value === undefined ? rest : { ...rest, [name]: value };
          const { props: __, ...without } = node;
          return Object.keys(props).length === 0 ? without : { ...without, props };
        }),
      };
    },
  };
}

/**
 * Sets the node's `path` (a PathShape's commands), `faces` (a Box's face settings) or `params` (a
 * prefab instance's parameter values), or removes it with `undefined`; the value it has already
 * is no change.
 */
export function setNodeField<K extends 'path' | 'faces' | 'params'>(
  path: DocPath,
  key: K,
  value: NodeDocument[K] | undefined,
): Command {
  return {
    label: `Set ${key}`,
    merge: `${key} ${pathString(path)}`,
    run: (document) => {
      if (same(existing(document, path)[key], value)) return { document };
      return {
        document: updateNode(document, path, (node) => {
          const { [key]: _, ...rest } = node;
          return value === undefined ? rest : { ...rest, [key]: value };
        }),
      };
    },
  };
}

/** Sets the node's display name, or removes it. */
export function setName(path: DocPath, name: string | undefined): Command {
  return {
    label: 'Rename',
    run: (document) => {
      const wanted = name?.trim() ? name : undefined;
      if (existing(document, path).name === wanted) return { document };
      return {
        document: updateNode(document, path, (node) => {
          const { name: _, ...rest } = node;
          return wanted === undefined ? rest : { ...rest, name: wanted };
        }),
      };
    },
  };
}

/**
 * Gives the node at `path` the id `id` (made unique against the expanded tree, see `uniqueId`:
 * the id it gets may differ from the one asked for), and renames every reference to its old id;
 * for a prefab instance, also to the ids its prefab makes, which its id prefixes
 * (`eye-left-pupil` → `eye-right-pupil`).
 */
export function renameNode(path: DocPath, id: string): Command {
  return {
    label: 'Rename id',
    run: (document) => {
      const node = existing(document, path);
      const old = node.id;
      // The ids its prefab makes go with its id: free them with it, and find a new id they are
      // free under too (another instance's ids, `eye` and `eye-left`, stay taken).
      const suffixes = madeSuffixes(document, node);
      const taken = expandedIds(document);
      if (old !== undefined) {
        taken.delete(old);
        for (const suffix of suffixes) taken.delete(`${old}-${suffix}`);
      }
      const next = uniqueId(id, taken, suffixes);
      if (old === next) return { document };
      const renamed = updateNode(document, path, (current) => ({ ...current, id: next }));
      const names = new Map<string, string>();
      if (old !== undefined) {
        names.set(old, next);
        for (const suffix of suffixes) names.set(`${old}-${suffix}`, `${next}-${suffix}`);
      }
      return { document: renameReferences(renamed, names) };
    },
  };
}

/**
 * Adds `node` as a child of the node at `parent`, at `index` (the end by default), with its ids
 * made unique; a node the editor makes gets an id from its type when it has none. Selects it.
 */
export function addNode(parent: DocPath, node: NodeDocument, index?: number): Command {
  return {
    label: 'Add node',
    run: (document) => {
      if (index !== undefined) checkIndex(index);
      const taken = expandedIds(document);
      const base = node.id ?? (node.prefab ?? node.type ?? 'node').toLowerCase();
      const made = withUniqueIds({ ...node, id: base }, taken, document);
      const children = existing(document, parent).children ?? [];
      const at =
        index === undefined ? children.length : Math.max(0, Math.min(index, children.length));
      return { document: insertChild(document, parent, at, made), selection: [...parent, at] };
    },
  };
}

/** The document with `child` put among the children of the node at `parent`, at `index`. */
function insertChild(
  document: MascotDocument,
  parent: DocPath,
  index: number,
  child: NodeDocument,
): MascotDocument {
  return updateNode(document, parent, (current) => {
    const children = [...(current.children ?? [])];
    children.splice(index, 0, child);
    return { ...current, children };
  });
}

function checkIndex(index: number): void {
  if (!Number.isInteger(index))
    throw new RangeError(`A child index must be an integer, got ${index}.`);
}

/** The path `path` takes after the node at `removed` is taken out (null if it was inside). */
function afterRemove(path: DocPath, removed: DocPath): DocPath | null {
  if (isWithin(path, removed)) return null;
  const depth = removed.length - 1;
  const prefix = removed.slice(0, depth);
  if (
    path.length > depth &&
    isWithin(path, prefix) &&
    (path[depth] as number) > (removed[depth] as number)
  ) {
    const next = [...path];
    next[depth] = (path[depth] as number) - 1;
    return next;
  }
  return path;
}

/** The path `path` takes after a node is put in at `inserted`. */
function afterInsert(path: DocPath, inserted: DocPath): DocPath {
  const depth = inserted.length - 1;
  const prefix = inserted.slice(0, depth);
  if (
    path.length > depth &&
    isWithin(path, prefix) &&
    (path[depth] as number) >= (inserted[depth] as number)
  ) {
    const next = [...path];
    next[depth] = (path[depth] as number) + 1;
    return next;
  }
  return path;
}

/** Removes the node at `path` (not the root) with its subtree; the selection follows. */
export function removeNode(path: DocPath): Command {
  return {
    label: 'Remove node',
    run: (document, selection) => {
      if (path.length === 0) throw new RangeError('The root cannot be removed.');
      existing(document, path);
      const parent = path.slice(0, -1);
      const index = path[path.length - 1] as number;
      const next = updateNode(document, parent, (current) => {
        const list = [...(current.children ?? [])];
        list.splice(index, 1);
        const { children: _, ...rest } = current;
        return list.length === 0 ? rest : { ...current, children: list };
      });
      return { document: next, selection: selection && afterRemove(selection, path) };
    },
  };
}

/**
 * Moves the node at `path` under the node at `parent`, to `index` among its children as they are
 * before the move; a node cannot move into itself. The selection follows.
 */
export function moveNode(path: DocPath, parent: DocPath, index: number): Command {
  return {
    label: 'Move node',
    run: (document, selection) => {
      if (path.length === 0) throw new RangeError('The root cannot be moved.');
      if (isWithin(parent, path)) throw new RangeError('A node cannot move into itself.');
      checkIndex(index);
      const node = existing(document, path);
      existing(document, parent);
      const removed = removeNode(path).run(document, null).document;
      // Where the parent and the index are once the node is out.
      const target = afterRemove(parent, path) as DocPath;
      const siblings = path.length - 1 === parent.length && isWithin(path, parent);
      const at = siblings && index > (path[path.length - 1] as number) ? index - 1 : index;
      const children = existing(removed, target).children ?? [];
      const slot = Math.max(0, Math.min(at, children.length));
      // Back where it was: no change, no step.
      if (samePath([...target, slot], path)) return { document };
      const next = insertChild(removed, target, slot, node);
      const moved = [...target, slot];
      let followed: DocPath | null = selection;
      if (selection !== null) {
        if (isWithin(selection, path)) followed = [...moved, ...selection.slice(path.length)];
        else {
          const out = afterRemove(selection, path);
          followed = out && afterInsert(out, moved);
        }
      }
      return { document: next, selection: followed };
    },
  };
}

/** Puts a copy of the node at `path`, with new ids, right after it, and selects the copy. */
export function duplicateNode(path: DocPath): Command {
  return {
    label: 'Duplicate node',
    run: (document) => {
      if (path.length === 0) throw new RangeError('The root cannot be duplicated.');
      const node = existing(document, path);
      const copy = withUniqueIds(node, expandedIds(document), document);
      const parent = path.slice(0, -1);
      const at = (path[path.length - 1] as number) + 1;
      return { document: insertChild(document, parent, at, copy), selection: [...parent, at] };
    },
  };
}

/** Where `setDocumentField` sets a value: a field of the document outside its tree. */
export type DocumentField =
  | readonly ['meta', 'name' | 'description']
  | readonly ['archetype']
  | readonly ['view', 'width' | 'height' | 'background']
  | readonly ['camera', 'props', string]
  | readonly ['params', string]
  | readonly ['palettes', string]
  | readonly ['palettes', string, string]
  | readonly ['prefabs', string]
  | readonly ['rig', 'slots', string];

/** The value `setDocumentField` sets at `F`: a shape parameter, a palette, a prefab, a number or text. */
export type FieldValue<F extends DocumentField = DocumentField> = F extends readonly [
  'params',
  string,
]
  ? ShapeParam
  : F extends readonly ['palettes', string]
    ? Readonly<Record<string, string>>
    : F extends readonly ['prefabs', string]
      ? PrefabDocument
      : F extends readonly ['view', 'width' | 'height']
        ? number
        : F extends readonly ['camera', 'props', string]
          ? PlainValue
          : string;

/**
 * Sets the document's field at `field` (`['view', 'width']`, `['camera', 'props', 'zoom']`), or
 * removes it with `undefined`; every object the removal leaves empty goes too (`camera.props`,
 * then `camera`), but a palette stays, though it names no role. The value it has already is no
 * change. The fields the format requires (`meta.name`, `view.width`, `view.height`) cannot be
 * removed.
 */
export function setDocumentField<F extends DocumentField>(
  field: F,
  value: FieldValue<F> | undefined,
): Command {
  const required =
    field[0] === 'meta' ? field[1] === 'name' : field[0] === 'view' && field[1] !== 'background';
  const name = field.join('.');
  return {
    label: `Set ${name}`,
    run: (document) => {
      if (value === undefined && required) {
        throw new RangeError(`${name} cannot be removed.`);
      }
      const set = (object: Record<string, unknown>, at: number): Record<string, unknown> => {
        const key = field[at] as string;
        const { [key]: current, ...rest } = object;
        const next =
          at === field.length - 1
            ? value
            : set(typeof current === 'object' && current !== null ? { ...current } : {}, at + 1);
        // A palette that names no role is still a palette (one that changes nothing yet).
        const kept = field[0] === 'palettes' && at === 1;
        const empty =
          next === undefined ||
          (at < field.length - 1 && !kept && Object.keys(next as object).length === 0);
        return empty ? rest : { ...object, [key]: next };
      };
      // Own keys only: a name such as "constructor" finds nothing.
      const before = field.reduce<unknown>(
        (object, key) =>
          typeof object === 'object' && object !== null && Object.hasOwn(object, key)
            ? (object as Record<string, unknown>)[key]
            : undefined,
        document,
      );
      if (same(before, value)) return { document };
      return { document: set({ ...document }, 0) as unknown as MascotDocument };
    },
  };
}

const TRANSFORM = ['position', 'rotation', 'scale', 'pivot'];

/** The names of the parameters the references in `value` name, at any depth. */
function paramsIn(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) paramsIn(item, names);
  else if (typeof value === 'object' && value !== null) {
    const { param } = value as { param?: unknown };
    if (typeof param === 'string') names.add(param);
    for (const item of Object.values(value)) paramsIn(item, names);
  }
  return names;
}

/** Whether `node` or a node under it is a prefab instance. */
function hasInstance(node: NodeDocument): boolean {
  return node.prefab !== undefined || (node.children ?? []).some(hasInstance);
}

/**
 * Makes the node at `path` and its subtree the document's new prefab `name`, and puts an instance
 * of it in its place; the expanded tree stays as it was:
 * - the instance keeps the node's id (or gets one from the prefab's name: an instance needs one)
 *   and name, and its place (its transform props); the prefab's root has the rest;
 * - an id under it that its id prefixes loses the prefix (the instance gives it back); another
 *   is renamed to the prefixed id everywhere, as the instance names it;
 * - a document parameter its values refer to becomes a parameter of the prefab, as the document
 *   has it, and the instance binds it to the document's.
 * A prefab holds no prefabs, so a subtree with an instance cannot become one; nor one whose ids
 * the instance would make twice, or make as another node's. Selects the instance.
 */
export function extractPrefab(path: DocPath, name: string): Command {
  return {
    label: 'Make prefab',
    run: (document) => {
      if (path.length === 0) throw new RangeError('The root cannot become a prefab.');
      const node = existing(document, path);
      if (hasInstance(node)) {
        throw new RangeError('A prefab holds no prefab instances, and this subtree has some.');
      }
      const wanted = name.trim();
      if (wanted === '') throw new RangeError('A prefab needs a name.');
      if (Object.hasOwn(document.prefabs ?? {}, wanted) || PREFABS.has(wanted)) {
        throw new RangeError(`The prefab name "${wanted}" is taken.`);
      }
      // The ids under it, as the prefab keeps them (without the instance's prefix).
      const own = (current: NodeDocument): string[] => [
        ...(current.id === undefined ? [] : [current.id]),
        ...(current.children ?? []).flatMap(own),
      ];
      const inside = (node.children ?? []).flatMap(own);
      const taken = expandedIds(document);
      for (const old of [...inside, ...(node.id === undefined ? [] : [node.id])]) taken.delete(old);
      const id = node.id ?? uniqueId(wanted, taken, inside);
      const unprefixed = (old: string) =>
        old.startsWith(`${id}-`) ? old.slice(id.length + 1) : old;
      const kept = inside.map(unprefixed);
      // The instance makes `id-kept` of each: none may be made twice, or be another node's.
      const made = new Set<string>();
      for (const suffix of kept) {
        const full = `${id}-${suffix}`;
        if (made.has(full) || taken.has(full)) {
          throw new RangeError(
            `The instance would make the id "${full}", which ${made.has(full) ? 'it makes twice' : 'another node has'}; rename it first.`,
          );
        }
        made.add(full);
      }
      const names = new Map<string, string>();
      const strip = (current: NodeDocument): NodeDocument => {
        const { id: own, children, ...rest } = current;
        if (own !== undefined && !own.startsWith(`${id}-`)) names.set(own, `${id}-${own}`);
        return {
          ...rest,
          ...(own === undefined ? {} : { id: unprefixed(own) }),
          ...(children === undefined ? {} : { children: children.map(strip) }),
        };
      };
      const { id: _, name: label, props, children, ...rest } = node;
      const entries = Object.entries(props ?? {});
      const place = entries.filter(([key]) => TRANSFORM.includes(key));
      const shape = entries.filter(([key]) => !TRANSFORM.includes(key));
      const root: NodeDocument = {
        ...rest,
        ...(shape.length === 0 ? {} : { props: Object.fromEntries(shape) }),
        ...(children === undefined ? {} : { children: children.map(strip) }),
      };
      const params = document.params ?? {};
      const used = [...paramsIn(root)].filter((param) => Object.hasOwn(params, param));
      const prefab: PrefabDocument = {
        ...(used.length === 0
          ? {}
          : {
              params: Object.fromEntries(used.map((param) => [param, params[param] as ShapeParam])),
            }),
        root,
      };
      const instance: NodeDocument = {
        prefab: wanted,
        id,
        ...(label === undefined ? {} : { name: label }),
        ...(used.length === 0
          ? {}
          : { params: Object.fromEntries(used.map((param) => [param, { param }])) }),
        ...(place.length === 0 ? {} : { props: Object.fromEntries(place) }),
      };
      const replaced = updateNode(document, path, () => instance);
      const next: MascotDocument = {
        ...replaced,
        prefabs: { ...replaced.prefabs, [wanted]: prefab },
      };
      return { document: renameReferences(next, names), selection: path };
    },
  };
}
