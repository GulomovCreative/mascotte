import { type Euler, euler } from '@mascotte/math';

/** Поворот в записи Zdog {x, y, z} для нового ядра. */
export function zdogRotation(x = 0, y = 0, z = 0): Euler {
  return euler.create(x, -y, z);
}
