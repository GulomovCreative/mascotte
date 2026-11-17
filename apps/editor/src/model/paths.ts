import type { MascotDocument, NodeDocument } from '@mascotte/format';

/**
 * A node of the document by its place in the tree: the child indices from the root (`[]` is the
 * root). Ids are optional and nodes inside a prefab instance have no node of their own, so the
 * editor addresses nodes by path (docs/EDITOR.md, 3.1).
 */
export type DocPath = readonly number[];

/** The node at `path`, or `null` if the tree has no node there. */
export function nodeAt(document: MascotDocument, path: DocPath): NodeDocument | null {
  let node: NodeDocument = document.root;
  for (const index of path) {
    const child = node.children?.[index];
    if (!child) return null;
    node = child;
  }
  return node;
}

/** The path as the format writes issue paths: `root.children[1].children[0]`. */
export function pathString(path: DocPath): string {
  return `root${path.map((index) => `.children[${index}]`).join('')}`;
}

/** Whether two paths name the same node. */
export function samePath(a: DocPath | null, b: DocPath | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((index, i) => index === b[i]);
}

/** Whether `path` is `ancestor` or inside it. */
export function isWithin(path: DocPath, ancestor: DocPath): boolean {
  return ancestor.length <= path.length && ancestor.every((index, i) => index === path[i]);
}

/**
 * The document with the node at `path` replaced by `change(node)`: the nodes along the path are
 * copied, the rest shared, so the previous document stays as it was (undo keeps it).
 */
export function updateNode(
  document: MascotDocument,
  path: DocPath,
  change: (node: NodeDocument) => NodeDocument,
): MascotDocument {
  const walk = (node: NodeDocument, depth: number): NodeDocument => {
    if (depth === path.length) return change(node);
    const index = path[depth] as number;
    const children = node.children ?? [];
    const child = children[index];
    if (!child) throw new RangeError(`No node at ${pathString(path)}.`);
    const next = [...children];
    next[index] = walk(child, depth + 1);
    return { ...node, children: next };
  };
  return { ...document, root: walk(document.root, 0) };
}
