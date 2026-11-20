import {
  expandDocument,
  type MascotDocument,
  NODE_TYPES,
  type NodeDocument,
} from '@mascotte/format';
import { PREFABS } from '@mascotte/library';
import { signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import {
  addNode,
  type Command,
  duplicateNode,
  moveNode,
  removeNode,
  renameNode,
} from '../model/commands.ts';
import { type DocPath, isWithin, nodeAt, pathString } from '../model/paths.ts';
import { attempt, editor, prefabMode, problem, state } from '../store.ts';

/** One row of the tree: a node of the document, or one a prefab instance makes (read-only). */
export interface TreeRow {
  /**
   * Unique among the rows: a written node's path as the format writes it (`root.children[1]`), a
   * made node's its parent row's key and `/<index>`.
   */
  readonly key: string;
  /** The node's path; for a made node, its instance's (selecting it selects the instance). */
  readonly path: DocPath;
  readonly made: boolean;
  /** The node as written, or as its prefab makes it. */
  readonly node: NodeDocument;
  /** The node as it builds (prefabs expanded, parameters set), for what it is (a decal). */
  readonly built: NodeDocument | undefined;
  readonly depth: number;
  /** Whether its children are shown; `null` without children. */
  readonly open: boolean | null;
}

/**
 * Rows whose folding was changed from the default (by key): a node is unfolded, a prefab
 * instance folded (its children and made nodes hidden), until toggled.
 */
// упрощение: свёрнутость хранится по пути, и после переноса или удаления узла может перейти к
// соседу; вернуться, если это будет мешать (хранить по id или по самому узлу).
export const toggled = signal<ReadonlySet<string>>(new Set());

const isNode = (value: unknown): value is NodeDocument =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A node's children, each at its index; what is not a node (in a broken document) is skipped. */
const childrenOf = (node: NodeDocument | undefined): (NodeDocument | undefined)[] =>
  Array.isArray(node?.children)
    ? node.children.map((child) => (isNode(child) ? child : undefined))
    : [];

/** The tree's rows as shown: the document's nodes, then each instance's made nodes, unfolded. */
export function treeRows(document: MascotDocument, folds: ReadonlySet<string>): TreeRow[] {
  const expanded = expandDocument(document).document as MascotDocument | undefined;
  const rows: TreeRow[] = [];
  const walk = (
    node: NodeDocument,
    built: NodeDocument | undefined,
    key: string,
    path: DocPath,
    depth: number,
    made: boolean,
  ) => {
    // An instance's own children come first in what it builds, at their places.
    const own = made ? [] : childrenOf(node);
    const builds = childrenOf(built);
    const makes = builds.slice(own.length);
    const count = [...own, ...makes].filter(Boolean).length;
    const closed = !made && node.prefab !== undefined;
    const open = count === 0 ? null : closed === folds.has(key);
    rows.push({ key, path, made, node, built, depth, open });
    if (!open) return;
    own.forEach((child, i) => {
      if (child) walk(child, builds[i], `${key}.children[${i}]`, [...path, i], depth + 1, false);
    });
    makes.forEach((child, i) => {
      if (child) walk(child, child, `${key}/${i}`, path, depth + 1, true);
    });
  };
  walk(document.root, isNode(expanded?.root) ? expanded.root : undefined, 'root', [], 0, false);
  return rows;
}

/**
 * The issues of each row, by key: an issue goes to its node's row (`root.children[1].props.x` to
 * `root.children[1]`), or to the nearest one shown above it (under a folded row, or at what is not
 * a node).
 */
function issuePaths(
  issues: readonly { path: string; message: string }[],
  rows: readonly TreeRow[],
): Map<string, string[]> {
  const shown = new Set(rows.map((row) => row.key));
  const byNode = new Map<string, string[]>();
  for (const issue of issues) {
    let node = /^root(\.children\[\d+\])*/.exec(issue.path)?.[0];
    if (!node) continue;
    while (!shown.has(node) && node !== 'root') node = node.replace(/\.children\[\d+\]$/, '');
    byNode.set(node, [...(byNode.get(node) ?? []), issue.message]);
  }
  return byNode;
}

/** The rig slots bound to each node id. */
function slotsById(document: MascotDocument): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  const slots = document.rig?.slots;
  if (!isNode(slots)) return byId;
  for (const [slot, id] of Object.entries(slots)) {
    if (typeof id === 'string') byId.set(id, [...(byId.get(id) ?? []), slot]);
  }
  return byId;
}

/** Runs a command on the open document, showing what goes wrong in the menu bar. */
function run(what: string, command: Command): void {
  attempt(what, () => editor.value.execute(command));
}

/** Where a drop puts the dragged node: before the row's node, after it, or inside it at the end. */
type Zone = 'before' | 'after' | 'inside';

/** The row a node is being dragged over and where it would go. */
const dropAt = signal<{ readonly key: string; readonly zone: Zone } | null>(null);
/** The row whose id is being edited. */
const renaming = signal<string | null>(null);
/** The node being dragged. */
let dragged: DocPath | null = null;

/**
 * The move a drop of `from` at `zone` of the node at `to` makes, or `null` if it cannot move
 * there or would stay where it is.
 */
export function dropMove(from: DocPath, to: DocPath, zone: Zone): Command | null {
  if (from.length === 0 || isWithin(to, from)) return null;
  if (zone === 'inside') return moveNode(from, to, Number.MAX_SAFE_INTEGER);
  if (to.length === 0) return null;
  const parent = to.slice(0, -1);
  const index = (to[to.length - 1] as number) + (zone === 'after' ? 1 : 0);
  const at = from[from.length - 1] as number;
  const siblings = from.length === to.length && isWithin(from, parent);
  if (siblings && (index === at || index === at + 1)) return null;
  return moveNode(from, parent, index);
}

/** The zone of a row at the pointer: its top and bottom quarters, or its middle. */
function zoneAt(event: DragEvent, row: HTMLElement): Zone {
  const box = row.getBoundingClientRect();
  const at = (event.clientY - box.top) / box.height;
  return at < 0.25 ? 'before' : at > 0.75 ? 'after' : 'inside';
}

const SHAPES = [...NODE_TYPES.keys()];

/** The menu that adds a shape or a prefab instance under the selected node (or the root). */
function AddMenu(props: { document: MascotDocument; parent: DocPath }) {
  const own = isNode(props.document.prefabs) ? Object.keys(props.document.prefabs) : [];
  // A prefab holds no prefabs: in a prefab's mode, none is offered.
  const prefabs = prefabMode.value ? [] : [...new Set([...PREFABS.keys(), ...own])];
  return (
    <select
      aria-label="Add"
      value=""
      onChange={(event) => {
        const select = event.currentTarget as HTMLSelectElement;
        const [kind, name] = select.value.split(':') as [string, string];
        select.value = '';
        if (!name) return;
        const node: NodeDocument = kind === 'prefab' ? { prefab: name } : { type: name };
        run('Could not add it', addNode(props.parent, node));
      }}
    >
      <option value="">Add…</option>
      <optgroup label="Shapes">
        {SHAPES.map((type) => (
          <option key={type} value={`type:${type}`}>
            {type}
          </option>
        ))}
      </optgroup>
      {prefabs.length === 0 ? null : (
        <optgroup label="Prefabs">
          {prefabs.map((name) => (
            <option key={name} value={`prefab:${name}`}>
              {name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/**
 * The input that edits a node's id in place: Enter or leaving it renames, Escape or an empty id
 * does not. An id taken (or one the format refuses) becomes a free one, and the menu bar says so.
 */
function RenameInput(props: { row: TreeRow }) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (keep: boolean, refocus: boolean) => {
    // Enter ends it before the input goes and blurs: one rename, not two.
    if (renaming.peek() !== props.row.key) return;
    renaming.value = null;
    const { path, node } = props.row;
    const value = input.current?.value.trim() ?? '';
    if (keep && value !== '' && value !== node.id) {
      run('Could not rename it', renameNode(path, value));
      const id = nodeAt(state.peek().document, path)?.id;
      if (id !== undefined && id !== value && id !== node.id) {
        problem.value = `Renamed to "${id}": "${value}" is taken or not allowed.`;
      }
    }
    // Focus goes back to the row from the keys; a click elsewhere keeps its own.
    if (refocus) document.querySelector<HTMLElement>(`[data-key="${props.row.key}"]`)?.focus();
  };
  return (
    <input
      ref={input}
      class="tree-rename"
      aria-label="Id"
      defaultValue={props.row.node.id ?? ''}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') finish(true, true);
        else if (event.key === 'Escape') finish(false, true);
      }}
      onBlur={() => finish(true, false)}
    />
  );
}

/**
 * The scene tree (docs/EDITOR.md, 3.4): the document's nodes with their ids and types, the rig
 * slots each binds, decals, prefab instances with their made nodes read-only under them, and
 * the issues at each node. A click selects; dragging a node onto another puts it inside (the
 * middle of the row) or before or after it (its edges). Keys: the arrows, Home and End move and
 * fold, F2 or Enter renames, Delete or Backspace removes, Ctrl+D (Cmd+D) duplicates, Escape
 * selects nothing (the inspector then shows the document).
 */
export function SceneTree() {
  const { document, selection, issues } = state.value;
  const rows = treeRows(document, toggled.value);
  const slots = slotsById(document);
  const problems = issuePaths(issues, rows);
  const list = useRef<HTMLDivElement>(null);
  const selected = selection === null ? null : pathString(selection);
  const editable = rows.filter((row) => !row.made);
  const focusable = selected !== null && editable.some((row) => row.key === selected);

  // A selection moved with the keys takes the focus along, before the next key comes.
  useLayoutEffect(() => {
    if (!list.current?.contains(globalThis.document.activeElement) || selected === null) return;
    list.current.querySelector<HTMLElement>(`[data-key="${selected}"]`)?.focus();
  }, [selected]);

  const select = (path: DocPath | null) =>
    attempt('Could not select it', () => editor.value.select(path));
  const toggle = (key: string) => {
    const next = new Set(toggled.value);
    if (!next.delete(key)) next.add(key);
    toggled.value = next;
  };

  const onKeyDown = (event: KeyboardEvent, row: TreeRow) => {
    const at = editable.indexOf(row);
    const go = (to: TreeRow | undefined) => to && select(to.path);
    switch (event.key) {
      case 'ArrowDown':
        go(editable[at + 1]);
        break;
      case 'ArrowUp':
        go(editable[at - 1]);
        break;
      case 'Home':
        go(editable[0]);
        break;
      case 'End':
        go(editable.at(-1));
        break;
      case 'ArrowRight':
        if (row.open === false) toggle(row.key);
        else if (row.open)
          go(editable[at + 1]?.depth === row.depth + 1 ? editable[at + 1] : undefined);
        break;
      case 'ArrowLeft':
        if (row.open) toggle(row.key);
        else if (row.path.length > 0) select(row.path.slice(0, -1));
        break;
      case 'Escape':
        select(null);
        break;
      case 'F2':
      case 'Enter':
        renaming.value = row.key;
        break;
      case 'Delete':
      case 'Backspace':
        if (row.path.length > 0) run('Could not remove it', removeNode(row.path));
        break;
      default:
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
          if (row.path.length > 0) run('Could not duplicate it', duplicateNode(row.path));
          break;
        }
        return;
    }
    event.preventDefault();
  };

  const parent = selection ?? [];
  const removable = selection !== null && selection.length > 0;
  return (
    <div class="scene-tree">
      <div class="tree-bar">
        <AddMenu document={document} parent={parent} />
        <button
          type="button"
          disabled={!removable}
          onClick={() => removable && run('Could not duplicate it', duplicateNode(selection))}
        >
          Duplicate
        </button>
        <button
          type="button"
          disabled={!removable}
          onClick={() => removable && run('Could not remove it', removeNode(selection))}
        >
          Remove
        </button>
      </div>
      <div class="tree-rows" role="tree" aria-label="Nodes" ref={list}>
        {rows.map((row) => {
          const { node, made } = row;
          const id = typeof node.id === 'string' ? node.id : null;
          const kind = node.prefab !== undefined ? String(node.prefab) : String(node.type ?? '?');
          const own = made ? undefined : problems.get(row.key);
          const bound = !made && id !== null ? slots.get(id) : undefined;
          const decal = row.built?.props?.sortMode === 'attached';
          const isSelected = !made && row.key === selected;
          const drop = dropAt.value?.key === row.key ? dropAt.value.zone : null;
          return (
            <div
              key={row.key}
              data-key={row.key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={row.open ?? undefined}
              aria-disabled={made || undefined}
              tabIndex={
                made ? undefined : isSelected || (!focusable && row.key === 'root') ? 0 : -1
              }
              class={`tree-row${made ? ' made' : ''}${drop ? ` drop-${drop}` : ''}`}
              style={{ paddingLeft: `${4 + row.depth * 14}px` }}
              draggable={!made && row.path.length > 0 && renaming.value !== row.key}
              onClick={() => select(row.path)}
              onDblClick={() => {
                if (!made) renaming.value = row.key;
              }}
              onKeyDown={(event) => !made && onKeyDown(event, row)}
              onDragStart={(event) => {
                dragged = row.path;
                event.dataTransfer?.setData('text/plain', row.key);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                dragged = null;
                dropAt.value = null;
              }}
              onDragOver={(event) => {
                if (made || !dragged) return;
                const zone = zoneAt(event, event.currentTarget as HTMLElement);
                if (!dropMove(dragged, row.path, zone)) return;
                event.preventDefault();
                if (dropAt.value?.key !== row.key || dropAt.value.zone !== zone) {
                  dropAt.value = { key: row.key, zone };
                }
              }}
              onDragLeave={() => {
                if (dropAt.value?.key === row.key) dropAt.value = null;
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = dragged;
                dragged = null;
                dropAt.value = null;
                if (made || !from) return;
                const move = dropMove(
                  from,
                  row.path,
                  zoneAt(event, event.currentTarget as HTMLElement),
                );
                if (move) run('Could not move it', move);
              }}
            >
              {row.open === null ? (
                <span class="tree-fold" />
              ) : (
                <button
                  type="button"
                  class="tree-fold"
                  tabIndex={-1}
                  aria-label={row.open ? 'Fold' : 'Unfold'}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(row.key);
                  }}
                >
                  {row.open ? '▾' : '▸'}
                </button>
              )}
              {renaming.value === row.key ? (
                <RenameInput row={row} />
              ) : (
                <span class="tree-id">{id ?? <em>no id</em>}</span>
              )}
              <span class="tree-type">{kind}</span>
              {node.prefab !== undefined && !made ? <span class="tree-mark">instance</span> : null}
              {bound ? <span class="tree-mark slot">{bound.join(', ')}</span> : null}
              {decal ? <span class="tree-mark">decal</span> : null}
              {own ? (
                <span
                  class="tree-issue"
                  title={own.join('\n')}
                  role="img"
                  aria-label={`${own.length} issues`}
                >
                  !
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
