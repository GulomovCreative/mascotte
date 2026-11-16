import {
  BOX_FACES,
  Box,
  type BoxFace,
  type BoxFaceSettings,
  type Node,
  PathShape,
  propertiesOf,
} from '@mascotte/engine';
import { color } from '@mascotte/math';
import type { NodeDocument, PropertyValue } from './document.ts';
import { NODE_TYPES } from './nodes.ts';

/** Throws unless JSON can hold the value and a document can read it back. */
function storable(node: Node, name: string, value: PropertyValue, isColor: boolean): void {
  const numbers =
    typeof value === 'number'
      ? [value]
      : typeof value === 'object' && value !== null
        ? Object.values(value)
        : [];
  // упрощение: zBias ±Infinity (разрешён движком) не записывается — в JSON нет бесконечности;
  // вернуться, когда редактору понадобится «всегда сверху/снизу» в документе.
  const finite = numbers.every(Number.isFinite);
  const parsed =
    !isColor || value === null || (typeof value === 'string' && color.parse(value) !== null);
  if (!finite || !parsed) {
    throw new Error(
      `writeNode: ${node.id}: ${name} = ${String(JSON.stringify(value) ?? value)} cannot be stored in a document.`,
    );
  }
}

function same(a: PropertyValue, b: PropertyValue): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b;
  return (
    a.x === b.x && a.y === b.y && a.z === b.z && ('w' in a ? a.w === (b as { w: number }).w : true)
  );
}

/** The node's properties (a camera's too) that differ from their defaults, by registry name. */
export function writeProps(node: Node): Record<string, PropertyValue> {
  const props: Record<string, PropertyValue> = {};
  for (const property of propertiesOf(node)) {
    let value: PropertyValue;
    if (property.type === 'vec3') value = property.get(node, { x: 0, y: 0, z: 0 });
    else if (property.type === 'quat') value = property.get(node, { x: 0, y: 0, z: 0, w: 1 });
    else value = property.get(node);
    if (same(value, property.default)) continue;
    storable(node, property.name, value, property.type === 'color');
    props[property.name] = value;
  }
  return props;
}

/**
 * Writes a node and its subtree as a document node: its type, a set id (not a generated one),
 * its name, the properties that differ from their defaults, a `PathShape`'s path and a `Box`'s
 * changed faces. Parts a solid made itself are left out. Throws an `Error` for a node type the
 * document cannot make, a value JSON cannot hold (NaN, ±Infinity) or a color it cannot read, and
 * a node added under a solid's part.
 */
export function writeNode(node: Node): NodeDocument {
  const typeName = (node.constructor as { typeName?: string }).typeName ?? '';
  if (NODE_TYPES.get(typeName) !== node.constructor) {
    throw new Error(`writeNode: a document cannot hold a node of type ${typeName || 'unknown'}.`);
  }
  const props = writeProps(node);
  const faces: Partial<Record<BoxFace, BoxFaceSettings>> = {};
  if (node instanceof Box) {
    for (const face of BOX_FACES) {
      const settings = node.getFace(face);
      if (settings.color !== null) storable(node, `faces.${face}.color`, settings.color, true);
      if (!settings.visible || settings.color !== null) faces[face] = { ...settings };
    }
  }
  for (const part of node.children) {
    // A part a solid made is not stored, so nothing may hang under it.
    if (part.owner !== null && part.children.some((child) => child.owner === null)) {
      throw new Error(
        `writeNode: ${part.id} is a part ${node.id} makes; a document cannot hold nodes added to it.`,
      );
    }
  }
  const children = node.children.filter((child) => child.owner === null).map(writeNode);
  return {
    type: typeName,
    ...(node.id.startsWith('~') ? {} : { id: node.id }),
    ...(node.name === '' ? {} : { name: node.name }),
    ...(Object.keys(props).length === 0 ? {} : { props }),
    ...(node instanceof PathShape ? { path: structuredClone(node.path) } : {}),
    ...(Object.keys(faces).length === 0 ? {} : { faces }),
    ...(children.length === 0 ? {} : { children }),
  };
}
