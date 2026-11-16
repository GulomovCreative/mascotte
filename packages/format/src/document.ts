import type {
  BehaviorSet,
  BlendMode,
  BoxFace,
  BoxFaceSettings,
  Clip,
  ConstraintSpec,
  PathCommand,
  SpringOptions,
  StateMachineSpec,
  StateSpec,
  Target,
} from '@mascotte/engine';
import type { Quat, Vec3 } from '@mascotte/math';

/** The `format` field every mascot document carries. */
export const FORMAT = 'mascotte';

/** A property value as stored: what the property registry reads and writes, as JSON. */
export type PropertyValue = number | boolean | string | null | Vec3 | Quat;

/**
 * A node of the tree: its type (`Node`, `Sphere`, `PathShape`, …), a stable `id` the rig,
 * clips and constraints refer to, its properties by registry name (`position`, `rotation` as a
 * quaternion, `style.color`, `diameter`; a missing one keeps its default) and its children.
 * A `PathShape` keeps its `path`, a `Box` its `faces`. Parts a solid makes itself (box faces,
 * cylinder bases) are not stored.
 */
export interface NodeDocument {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly props?: Readonly<Record<string, PropertyValue>>;
  readonly path?: readonly PathCommand[];
  readonly faces?: Readonly<Partial<Record<BoxFace, Partial<BoxFaceSettings>>>>;
  readonly children?: readonly NodeDocument[];
}

/** A motion as stored: inline, or the name of one in `motions`. */
export type MotionRef = string | MotionDocument;

/** A blend whose points may name their motions. */
export interface BlendDocument {
  readonly input: string;
  readonly blend: readonly { readonly at: number; readonly motion: MotionRef }[];
}

/** A clip, a behavior set or a blend (see `Motion` in the engine). */
export type MotionDocument = Clip | BehaviorSet | BlendDocument;

/** An animator layer, in blend order; `play` is the motion it plays from the start. */
export interface LayerDocument {
  readonly name: string;
  readonly mode?: BlendMode;
  readonly weight?: number;
  readonly mask?: Target | null;
  readonly play?: MotionRef | null;
}

/** A state machine whose states may name their motions. */
export interface MachineDocument extends Omit<StateMachineSpec, 'states'> {
  readonly states: readonly (Omit<StateSpec, 'motion'> & { readonly motion?: MotionRef | null })[];
}

/** A constraint with an optional name, by which the page finds it (a gaze, say). */
export type ConstraintDocument = ConstraintSpec & { readonly name?: string };

/**
 * A mascot document: JSON with an explicit format version. Everything the player and the
 * editor need to rebuild the mascot: its frame, camera, node tree, rig slots, motions,
 * layers, state machines (with their inputs), constraints and springs.
 */
export interface MascotDocument {
  readonly format: typeof FORMAT;
  readonly version: number;
  readonly meta: { readonly name: string; readonly description?: string };
  /** The frame size in scene units and its background color. */
  readonly view: { readonly width: number; readonly height: number; readonly background?: string };
  /** Camera properties by registry name (`zoom`, `projection`, `distance`, …). */
  readonly camera?: { readonly props?: Readonly<Record<string, PropertyValue>> };
  readonly root: NodeDocument;
  /** Rig slots bound to node ids. */
  readonly rig?: { readonly slots?: Readonly<Record<string, string>> };
  /** Named motions that layers, states and blends refer to. */
  readonly motions?: Readonly<Record<string, MotionDocument>>;
  readonly layers?: readonly LayerDocument[];
  readonly machines?: readonly MachineDocument[];
  /** In evaluation order. */
  readonly constraints?: readonly ConstraintDocument[];
  readonly springs?: readonly SpringOptions[];
}

/** One problem in a document: where (`root.children[2].props.diameter`) and what. */
export interface Issue {
  readonly path: string;
  readonly message: string;
}

/** A document that cannot be read or built, with every problem found. */
export class DocumentError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    const lines = issues.map((issue) => `${issue.path || '(document)'}: ${issue.message}`);
    super(`Invalid mascot document:\n${lines.join('\n')}`);
    this.name = 'DocumentError';
    this.issues = issues;
  }
}
