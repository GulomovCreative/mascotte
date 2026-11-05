import { type Euler, euler } from '@mascotte/math';

/** A rotation in Zdog {x, y, z} notation for the new engine. */
export function zdogRotation(x = 0, y = 0, z = 0): Euler {
  return euler.create(x, -y, z);
}
