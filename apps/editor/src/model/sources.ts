import type { Node } from '@mascotte/engine';
import type { MascotDocument, NodeDocument } from '@mascotte/format';
import type { DocPath } from './paths.ts';

/**
 * Where each built node came from in the document. Building keeps the tree's order: a node's
 * children are the document's (a solid's own parts, which carry an `owner`, aside), and a prefab
 * instance's are its own children first, then the prefab's nodes. So the built tree is walked
 * beside the document: a node maps to its document node's path, a prefab's node to its instance,
 * a solid's part to the solid.
 */
export function sourceMap(root: Node, document: MascotDocument): Map<Node, DocPath> {
  const map = new Map<Node, DocPath>();
  const walk = (node: Node, source: NodeDocument | null, path: DocPath) => {
    map.set(node, path);
    const own = source?.children ?? [];
    let index = 0;
    for (const child of node.children) {
      if (child.owner !== null) {
        // A solid's part, with whatever it holds, is the solid's.
        child.traverse((part) => {
          map.set(part, path);
        });
        continue;
      }
      if (index < own.length) {
        walk(child, own[index] as NodeDocument, [...path, index]);
      } else {
        // A prefab's own node, with its subtree, is its instance's.
        child.traverse((made) => {
          map.set(made, path);
        });
      }
      index++;
    }
  };
  walk(root, document.root, []);
  return map;
}
