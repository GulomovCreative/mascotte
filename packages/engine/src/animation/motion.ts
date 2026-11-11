import type { BehaviorSet } from './behaviors.ts';
import type { Blend1D } from './blend.ts';
import type { Clip } from './clip.ts';

/**
 * What a layer plays: a keyed clip, a set of procedural behaviors, or a blend of those by a
 * number input (see blend.ts).
 */
export type Motion = Clip | BehaviorSet | Blend1D;

/** The kinds of motion, told apart by their keys: `blend`, `behaviors` or `tracks`. */
export type MotionKind = 'clip' | 'behaviors' | 'blend';

/** The kind of `motion`; throws a TypeError for a value that is none of them. */
export function motionKind(motion: Motion): MotionKind {
  if (typeof motion === 'object' && motion !== null && !Array.isArray(motion)) {
    if ('blend' in motion) return 'blend';
    if ('behaviors' in motion) return 'behaviors';
    if ('tracks' in motion) return 'clip';
  }
  let keys: string;
  try {
    keys =
      typeof motion === 'object' && motion !== null
        ? `keys ${Object.keys(motion).join(', ') || 'none'}`
        : String(motion);
  } catch {
    keys = 'something else';
  }
  throw new TypeError(
    'A motion must be a clip { duration, loop, tracks }, behaviors { behaviors } or a blend ' +
      `{ input, blend }, got ${keys}.`,
  );
}
