import {
  BlobShadow,
  Box,
  Capsule,
  Cone,
  Cylinder,
  Ellipse,
  Hemisphere,
  Node,
  PathShape,
  Polygon,
  Rect,
  RoundedRect,
  Sphere,
} from '@mascotte/engine';

/** A node class the document can make: built from options, then set through the registry. */
// biome-ignore lint/suspicious/noExplicitAny: node classes take different options.
export type NodeType = (new (options?: any) => Node) & { readonly typeName: string };

/**
 * The node types a document's tree may use, by `typeName`. Surfaces a solid makes for itself
 * (`HemisphereDome`, `CylinderBody`, `ConeSurface`) are not among them.
 */
export const NODE_TYPES: ReadonlyMap<string, NodeType> = new Map(
  [
    Node,
    Ellipse,
    Rect,
    RoundedRect,
    Polygon,
    PathShape,
    Sphere,
    Capsule,
    Hemisphere,
    Cylinder,
    Cone,
    Box,
    BlobShadow,
  ].map((type) => [type.typeName, type as NodeType]),
);
