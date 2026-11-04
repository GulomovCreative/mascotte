/**
 * Порядок осей для углов Эйлера. `'XYZ'` означает матрицу `Rx · Ry · Rz`: вектор
 * поворачивается сначала вокруг Z, потом вокруг Y, потом вокруг X (оси неподвижны).
 * То же самое можно читать как повороты вокруг собственных осей объекта в порядке X, Y, Z.
 */
export type EulerOrder = 'XYZ' | 'XZY' | 'YXZ' | 'YZX' | 'ZXY' | 'ZYX';

export const EULER_ORDERS: readonly EulerOrder[] = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];

/** Углы Эйлера в радианах. Используются только для ввода: внутри повороты хранятся кватернионами. */
export interface Euler {
  x: number;
  y: number;
  z: number;
  order: EulerOrder;
}

export function create(x = 0, y = 0, z = 0, order: EulerOrder = 'XYZ'): Euler {
  return { x, y, z, order };
}
