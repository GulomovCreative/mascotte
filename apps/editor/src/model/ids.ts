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
 * The suffixes of the ids a prefab instance makes under its own (`pupil` for `eye-left-pupil`):
 * its prefab expanded on its own, with its parameters, in `document`. None for another node.
 */
export function madeSuffixes(document: MascotDocument, node: NodeDocument): string[] {
  if (node.prefab === undefined) return [];
  const probe = 'probe';
  const { children: _, ...instance } = node;
  const expanded = expandDocument({
    ...document,
    root: { type: 'Node', children: [{ ...instance, id: probe }] },
  }).document as MascotDocument;
  const suffixes: string[] = [];
  const walk = (made: NodeDocument) => {
    if (made.id?.startsWith(`${probe}-`)) suffixes.push(made.id.slice(probe.length + 1));
    for (const child of made.children ?? []) walk(child);
  };
  for (const child of expanded.root.children?.[0]?.children ?? []) walk(child);
  return suffixes;
}

/**
 * `base`, or `base-2`, `base-3`, … : the first that is not in `taken`, nor makes an id in `taken`
 * with any of `suffixes` (a prefab instance's, see `madeSuffixes`). Only what the format refuses
 * in an id is changed: a `/` (it joins a solid's id to its parts') and a leading `~` (built
 * nodes' own); an empty id becomes `node`.
 */
export function uniqueId(
  base: string,
  taken: ReadonlySet<string>,
  suffixes: readonly string[] = [],
): string {
  const clean = base.trim().replaceAll('/', '-').replace(/^~+/, '') || 'node';
  const free = (id: string) =>
    !taken.has(id) && suffixes.every((suffix) => !taken.has(`${id}-${suffix}`));
  if (free(clean)) return clean;
  for (let n = 2; ; n++) {
    const candidate = `${clean}-${n}`;
    if (free(candidate)) return candidate;
  }
}

/**
 * A copy of `node` and its subtree with every id made unique against `taken` (which grows with
 * them, and with the ids their prefab instances make), in `document`.
 */
export function withUniqueIds(
  node: NodeDocument,
  taken: Set<string>,
  document: MascotDocument,
): NodeDocument {
  const suffixes = madeSuffixes(document, node);
  const id = node.id === undefined ? undefined : uniqueId(node.id, taken, suffixes);
  if (id !== undefined) {
    taken.add(id);
    for (const suffix of suffixes) taken.add(`${id}-${suffix}`);
  }
  const children = node.children?.map((child) => withUniqueIds(child, taken, document));
  return {
    ...node,
    ...(id === undefined ? {} : { id }),
    ...(children === undefined ? {} : { children }),
  };
}
