/**
 * Axis order for Euler angles. `'XYZ'` means the matrix `Rx · Ry · Rz`: a vector
 * is rotated first about Z, then about Y, then about X (fixed axes).
 * Equivalently, these are rotations about the object's own axes in the order X, Y, Z.
 */
export type EulerOrder = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';

export const EULER_ORDERS = [
  'XYZ',
  'XZY',
  'YXZ',
  'YZX',
  'ZXY',
  'ZYX',
] as const satisfies readonly EulerOrder[];

/** Whether a string is a valid axis order. Used when parsing the document. */
export function isEulerOrder(value: string): value is EulerOrder {
  return (EULER_ORDERS as readonly string[]).includes(value);
}

/** Euler angles in radians. Used for input only: rotations are stored internally as quaternions. */
export interface Euler {
  x: number;
  y: number;
  z: number;
  order: EulerOrder;
}

export function create(x = 0, y = 0, z = 0, order: EulerOrder = 'XYZ'): Euler {
  return { x, y, z, order };
}
