import type { MascotDocument, MotionDocument, MotionRef } from '@mascotte/format';

/** A target as documents store it: a node id, or a rig slot. */
type Target = string | { readonly slot: string };

/** Fields of a constraint that name nodes. */
const CONSTRAINT_TARGETS = ['target', 'at', 'mid', 'pole', 'from'] as const;

function renamed(target: unknown, names: ReadonlyMap<string, string>): unknown {
  return typeof target === 'string' && names.has(target) ? names.get(target) : target;
}

/** A motion with the node ids its tracks, behaviors and blend points name renamed. */
function renameMotion(motion: MotionRef, names: ReadonlyMap<string, string>): MotionRef {
  if (typeof motion === 'string' || typeof motion !== 'object' || motion === null) return motion;
  if ('tracks' in motion) {
    return {
      ...motion,
      tracks: motion.tracks.map((track) => ({
        ...track,
        target: renamed(track.target, names) as Target,
      })),
    };
  }
  if ('behaviors' in motion && Array.isArray(motion.behaviors)) {
    return {
      ...motion,
      behaviors: motion.behaviors.map((behavior) => ({
        ...behavior,
        target: renamed(behavior.target, names) as Target,
      })),
    } as MotionRef;
  }
  if ('blend' in motion && Array.isArray(motion.blend)) {
    return {
      ...motion,
      blend: motion.blend.map((point) => ({
        ...point,
        motion: renameMotion(point.motion as MotionRef, names),
      })),
    } as MotionRef;
  }
  return motion;
}

/**
 * The document with every reference to a node id renamed by `names` (old id → new id): rig
 * slots, track and behavior targets (in motions, layers and states, blend points included),
 * layer masks, the node fields of constraints (`target`, `at`, `mid`, `pole`, `from`) and spring
 * targets. Slots (`{ slot }`) name no ids and stay. The nodes' own ids are not touched.
 */
export function renameReferences(
  document: MascotDocument,
  names: ReadonlyMap<string, string>,
): MascotDocument {
  if (names.size === 0) return document;
  const slots = document.rig?.slots;
  const motions = document.motions;
  return {
    ...document,
    ...(slots === undefined
      ? {}
      : {
          rig: {
            ...document.rig,
            slots: Object.fromEntries(
              Object.entries(slots).map(([slot, id]) => [slot, names.get(id) ?? id]),
            ),
          },
        }),
    ...(motions === undefined
      ? {}
      : {
          motions: Object.fromEntries(
            Object.entries(motions).map(([name, motion]) => [
              name,
              renameMotion(motion, names) as MotionDocument,
            ]),
          ),
        }),
    ...(document.layers === undefined
      ? {}
      : {
          layers: document.layers.map((layer) => ({
            ...layer,
            ...(layer.mask === undefined || layer.mask === null
              ? {}
              : { mask: renamed(layer.mask, names) as Target }),
            ...(layer.play === undefined || layer.play === null
              ? {}
              : { play: renameMotion(layer.play, names) }),
          })),
        }),
    ...(document.machines === undefined
      ? {}
      : {
          machines: document.machines.map((machine) => ({
            ...machine,
            states: machine.states.map((state) =>
              state.motion === undefined || state.motion === null
                ? state
                : { ...state, motion: renameMotion(state.motion, names) },
            ),
          })),
        }),
    ...(document.constraints === undefined
      ? {}
      : {
          constraints: document.constraints.map((constraint) => {
            const next: Record<string, unknown> = { ...constraint };
            for (const field of CONSTRAINT_TARGETS) {
              if (field in next) next[field] = renamed(next[field], names);
            }
            return next as unknown as typeof constraint;
          }),
        }),
    ...(document.springs === undefined
      ? {}
      : {
          springs: document.springs.map((spring) => ({
            ...spring,
            target: renamed(spring.target, names) as Target,
          })),
        }),
  };
}
