import { expandDocument, type MascotDocument, type NodeDocument } from '@mascotte/format';

/**
 * Ids in the document as it builds: prefab instances prefix the ids of their nodes, so an id is
 * unique only against the expanded tree (`eye` + `left` must not meet a node `eye-left`).
 */
export function expandedIds(document: MascotDocument): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node !== 'object' || node === null) return;
    const { id, children } = node as NodeDocument;
    if (typeof id === 'string') ids.add(id);
    if (Array.isArray(children)) for (const child of children) walk(child);
  };
  walk((expandDocument(document).document as MascotDocument).root);
  // Ids written in the document count too, whatever expansion makes of them.
  const own = (node: NodeDocument) => {
    if (node.id !== undefined) ids.add(node.id);
    for (const child of node.children ?? []) own(child);
  };
  own(document.root);
  return ids;
}

/**
 * `base`, or `base-2`, `base-3`, … : the first not in `taken`. Only what the format refuses in an
 * id is changed: a `/` (it joins a solid's id to its parts') and a leading `~` (built nodes'
 * own); an empty id becomes `node`.
 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const clean = base.trim().replaceAll('/', '-').replace(/^~+/, '') || 'node';
  if (!taken.has(clean)) return clean;
  for (let n = 2; ; n++) {
    const candidate = `${clean}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A copy of `node` and its subtree with every id made unique against `taken` (which grows). */
export function withUniqueIds(node: NodeDocument, taken: Set<string>): NodeDocument {
  const id = node.id === undefined ? undefined : uniqueId(node.id, taken);
  if (id !== undefined) taken.add(id);
  const children = node.children?.map((child) => withUniqueIds(child, taken));
  return {
    ...node,
    ...(id === undefined ? {} : { id }),
    ...(children === undefined ? {} : { children }),
  };
}
