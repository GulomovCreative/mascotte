import type {
  BehaviorSet,
  BlendMode,
  BoxFace,
  BoxFaceSettings,
  Clip,
  ConstraintSpec,
  PathCommand,
  PathPoint,
  SpringOptions,
  StateMachineSpec,
  StateSpec,
  Target,
} from '@mascotte/engine';
import type { Quat, Vec3 } from '@mascotte/math';

/** The `format` field every mascot document carries. */
export const FORMAT = 'mascotte';

/**
 * A value computed from a shape parameter: `param × times + plus`. `times` (1 by default) and
 * `plus` (0 by default) are numbers for a number, or vectors `{x, y, z}` for a vector; `plus`
 * may itself be a reference, so a vector can depend on several parameters. Inside a prefab it
 * names the prefab's parameters, elsewhere the document's.
 *
 * A reference stands for a whole value, never for one coordinate inside `{x, y, z}`: V8 shares
 * one hidden class among all `{x, y, z}` objects, and a single one holding something other than
 * numbers there makes every vector in the engine box its numbers.
 */
export interface ParamRef {
  readonly param: string;
  readonly times?: number | Readonly<Vec3>;
  readonly plus?: number | Readonly<Vec3> | ParamRef;
}

/** A number as stored: a literal, or computed from a parameter. */
export type Num = number | ParamRef;

/** A property value as stored: what the property registry reads and writes, as JSON. */
export type PropertyValue = number | boolean | string | null | Vec3 | Quat | ParamRef;

/** A path command as stored: each of its points may be computed from parameters. */
export type PathCommandDocument = PathCommand extends infer C
  ? C extends PathCommand
    ? { readonly [K in keyof C]: C[K] extends PathPoint ? PathPoint | ParamRef : C[K] }
    : never
  : never;

/** A shape parameter: a number with a default and an optional range. */
export interface ParamSpec {
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly description?: string;
}

/**
 * A prefab: a subtree with its own parameters, put into a tree by `{ prefab, id, params }`.
 * Its numbers may refer to its parameters; it holds no prefabs itself.
 */
export interface PrefabDocument {
  readonly description?: string;
  readonly params?: Readonly<Record<string, ParamSpec>>;
  readonly root: NodeDocument;
}

/**
 * A node of the tree: its type (`Node`, `Sphere`, `PathShape`, …), a stable `id` the rig,
 * clips and constraints refer to, its properties by registry name (`position`, `rotation` as a
 * quaternion, `style.color`, `diameter`; a missing one keeps its default) and its children.
 * A `PathShape` keeps its `path`, a `Box` its face settings. The child nodes a solid makes
 * itself (a box's face rects, a cylinder's bases) are not stored.
 *
 * Instead of a `type`, a node may name a `prefab` (the document's own or the library's) with
 * an `id` and values for its `params`: it becomes the prefab's subtree, whose ids are prefixed
 * with this id (`eye-left` + `pupil` → `eye-left-pupil`), whose root takes these `props` and
 * `name`, and which gets these `children` as well.
 */
export interface NodeDocument {
  readonly type?: string;
  readonly prefab?: string;
  readonly params?: Readonly<Record<string, Num>>;
  readonly id?: string;
  readonly name?: string;
  readonly props?: Readonly<Record<string, PropertyValue>>;
  readonly path?: readonly PathCommandDocument[];
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

/**
 * A motion of the library (`MOTIONS` in `@mascotte/library`) by its name: written for slots,
 * with positions in sizes of the mascot, which its `archetype` measures.
 */
export interface LibraryMotionRef {
  readonly library: string;
}

/** A clip, a behavior set, a blend (see `Motion` in the engine) or a library motion. */
export type MotionDocument = Clip | BehaviorSet | BlendDocument | LibraryMotionRef;

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
  /** Shape parameters: numbers the tree's geometry is computed from, set again when built. */
  readonly params?: Readonly<Record<string, ParamSpec>>;
  /** The document's own prefabs, by name; the library's are there too. */
  readonly prefabs?: Readonly<Record<string, PrefabDocument>>;
  /**
   * The archetype (`ARCHETYPES` in `@mascotte/library`): the rig binds its slots, and library
   * motions measure the mascot's size by it.
   */
  readonly archetype?: string;
  /** The frame size in CSS pixels (before devicePixelRatio) and its background color. */
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

  constructor(issues: readonly Issue[], options?: ErrorOptions) {
    const lines = issues.map((issue) => `${issue.path || '(document)'}: ${issue.message}`);
    super(`Invalid mascot document:\n${lines.join('\n')}`, options);
    this.name = 'DocumentError';
    this.issues = issues;
  }
}
