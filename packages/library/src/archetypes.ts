/**
 * An archetype: a standard set of rig slots a mascot binds its own nodes to, so motions written
 * for the slots fit every mascot of that kind. `size` names two slots whose distance (between
 * their pivots, at rest) is the mascot's size: library motions give offsets in sizes, so a
 * hop of a tall mascot is as high, for its size, as a short one's.
 */
export interface Archetype {
  readonly name: string;
  readonly description: string;
  /** Slots every mascot of the archetype binds. */
  readonly slots: readonly string[];
  /** Slots it may bind; motions that use them fit only mascots that do. */
  readonly optional: readonly string[];
  /** Two required slots whose pivots, at rest, are the mascot's size apart. */
  readonly size: readonly [string, string];
}

/** An archetype whose size slots the compiler checks are among its required slots. */
function archetype<const S extends string>(spec: {
  name: string;
  description: string;
  slots: readonly S[];
  optional: readonly string[];
  size: readonly [NoInfer<S>, NoInfer<S>];
}): Archetype {
  return spec;
}

/** Slots every archetype has: the root at the feet, the body, the eyes and the closed lids. */
const COMMON = ['root', 'body', 'eyes', 'lids'] as const;

/** The standard archetypes, by name. */
export const ARCHETYPES: ReadonlyMap<string, Archetype> = new Map(
  [
    archetype({
      name: 'blob',
      description: 'A body with a face on it and nothing else: a slime, a ball, a drop.',
      slots: [...COMMON],
      optional: ['head', 'mouth'],
      size: ['root', 'eyes'],
    }),
    archetype({
      name: 'biped',
      description: 'A head on a body, two arms, maybe legs and ears: a person, a bear.',
      slots: [...COMMON, 'head', 'arm.L', 'arm.R'],
      optional: ['mouth', 'leg.L', 'leg.R', 'ear.L', 'ear.R'],
      size: ['root', 'head'],
    }),
    archetype({
      name: 'quadruped',
      description: 'A head on a body on four legs, with a tail: a cat, a dog, a fox.',
      slots: [...COMMON, 'head', 'tail'],
      optional: ['mouth', 'leg.FL', 'leg.FR', 'leg.BL', 'leg.BR', 'ear.L', 'ear.R'],
      size: ['root', 'head'],
    }),
    archetype({
      name: 'bird',
      description: 'A round body with two wings and a beak that opens: a chick, an owl.',
      slots: [...COMMON, 'head', 'wing.L', 'wing.R', 'beak.lower'],
      optional: ['beak.upper', 'crest.L', 'crest.M', 'crest.R', 'eye.L', 'eye.R', 'eyes.happy'],
      size: ['root', 'head'],
    }),
    archetype({
      name: 'face',
      description: 'An object with a face: a phone, a cup, a box with a screen.',
      slots: [...COMMON],
      optional: ['head', 'mouth'],
      size: ['root', 'eyes'],
    }),
  ].map((archetype) => [archetype.name, archetype]),
);
