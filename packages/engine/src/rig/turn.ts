import { type Mat3x4, mat3x4, type Quat, quat, type Vec3, vec3 } from '@mascotte/math';
import type { Node } from '../scene/node.ts';

const from = vec3.create();
const to = vec3.create();
const inverse: Mat3x4 = mat3x4.create();
const turn: Quat = quat.create();
const IDENTITY: Readonly<Quat> = quat.create();

/**
 * Turns `node` about its pivot by the smallest rotation that takes world direction `fromWorld`
 * to `toWorld`: `weight` (0 to 1) of that turn after limiting it to `maxAngle` radians. The
 * rotation is found in the parent's space, where the node's rotation applies, and put before
 * the node's own rotation. Does nothing for a parent that cannot be inverted (scale 0) or zero
 * vectors. Allocates nothing. Under non-uniform scale of an ancestor the direction still ends
 * exactly on `toWorld`, but the angle (`maxAngle`, `weight`) and "smallest" are measured in
 * the parent's space, not in the world.
 */
export function turnNode(
  node: Node,
  fromWorld: Readonly<Vec3>,
  toWorld: Readonly<Vec3>,
  maxAngle = Math.PI,
  weight = 1,
): void {
  vec3.copy(from, fromWorld);
  vec3.copy(to, toWorld);
  const parent = node.parent;
  if (parent) {
    if (!mat3x4.invert(inverse, parent.worldMatrix)) return;
    mat3x4.transformDirection(from, inverse, from);
    mat3x4.transformDirection(to, inverse, to);
  }
  turnInParent(node, from, to, maxAngle, weight);
}

/** `turnNode` with the directions already in the parent's space (the world for a root). */
export function turnInParent(
  node: Node,
  fromParent: Readonly<Vec3>,
  toParent: Readonly<Vec3>,
  maxAngle = Math.PI,
  weight = 1,
): void {
  quat.rotationTo(turn, fromParent, toParent);
  const angle = quat.angleBetween(turn, IDENTITY);
  const limited = Math.min(angle, maxAngle) * weight;
  if (!(limited > 0)) return;
  if (limited < angle) quat.slerp(turn, IDENTITY, turn, limited / angle);
  quat.multiply(turn, turn, node.rotation);
  node.rotation.copy(turn);
}

/** The world position of `node`'s pivot. */
export function pivotOf(out: Vec3, node: Node): Vec3 {
  return node.localToWorld(out, node.pivot);
}
