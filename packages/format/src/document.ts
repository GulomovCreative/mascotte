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
import type { PrefabParam } from '@mascotte/library';
import type { Quat, Vec3 } from '@mascotte/math';

/** The `format` field every mascot document carries. */
export const FORMAT = 'mascotte';

/**
 * A number computed from a shape parameter: `param × times + plus` (`times` 1 and `plus` 0 by
 * default); `plus` may itself be a reference, so a number can depend on several parameters.
 * Inside a prefab it names the prefab's parameters, elsewhere the document's.
 */
export interface ScalarRef {
  readonly param: string;
  readonly times?: number;
  readonly plus?: number | ScalarRef;
}

/**
 * A vector computed from shape parameters: `param × times + plus`, with vectors for `times` and
 * `plus` (which may itself be a reference). A reference stands for a whole vector, never for one
 * coordinate inside `{x, y, z}`, and validation refuses one there: `{x, y, z}` objects built
 * alike share a V8 hidden class, and one holding something other than a number in a coordinate
 * generalizes that class, so every store into those vectors in the engine then allocates (the
 * allocation tests caught this).
 */
export interface VectorRef {
  readonly param: string;
  readonly times: Readonly<Vec3>;
  readonly plus?: Readonly<Vec3> | VectorRef;
}

/** Any reference to a shape parameter. */
export type ParamRef = ScalarRef | VectorRef;

/** A number as stored: a literal, or computed from a parameter. */
export type Num = number | ScalarRef;

/** A property value as the registry reads and writes it, as JSON: plain, with no references. */
export type PlainValue = number | boolean | string | null | Vec3 | Quat;

/**
 * A color taken from the palette by its role (`{ "color": "body" }`): the running palette's
 * color for that role, or the first palette's if the running one does not name it.
 */
export interface ColorRef {
  readonly color: string;
}

/** Whether a stored value is a palette color `{ color: role }`, and nothing else. */
export function isColorRef(value: unknown): value is ColorRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { color?: unknown }).color === 'string'
  );
}

/**
 * A property value as stored in the tree: plain, computed from parameters, or a palette color
 * (only on a color property).
 */
export type PropertyValue = PlainValue | ParamRef | ColorRef;

/** A path command as stored: each of its points may be computed from parameters. */
export type PathCommandDocument = PathCommand extends infer C
  ? C extends PathCommand
    ? { readonly [K in keyof C]: C[K] extends PathPoint ? PathPoint | VectorRef : C[K] }
    : never
  : never;

/** A shape parameter: a number with a default and an optional range (the library's own type). */
export type ShapeParam = PrefabParam;

/**
 * A prefab: a subtree with its own parameters, put into a tree by `{ prefab, id, params }`.
 * Its numbers may refer to its parameters; it holds no prefabs itself.
 */
export interface PrefabDocument {
  readonly description?: string;
  readonly params?: Readonly<Record<string, ShapeParam>>;
  readonly root: NodeDocument;
}

/**
 * A node of the tree: its type (`Node`, `Sphere`, `PathShape`, …), a stable `id` the rig,
 * clips and constraints refer to, its properties by registry name (`position`, `rotation` as a
 * quaternion, `style.color`, `diameter`; a missing one keeps its default) and its children.
 * A `PathShape` keeps its `path`, a `Box` its face settings. The child nodes a solid makes
 * itself (a box's face rects, a cylinder's bases) are not stored.
 *
 * Instead of a `type` (and a `path` or `faces`), a node may name a `prefab` (the document's own
 * or the library's) with an `id` and values for its `params`: it becomes the prefab's subtree.
 * Its root gets this `id` and `name`, with these `props` over its own; the other ids are
 * prefixed with this id (`eye-left` + `pupil` → `eye-left-pupil`); these `children` come before
 * its own.
 */
export interface NodeDocument {
  readonly type?: string;
  readonly prefab?: string;
  readonly params?: Readonly<Record<string, Num>>;
  readonly id?: string;
  readonly name?: string;
  readonly props?: Readonly<Record<string, PropertyValue>>;
  readonly path?: readonly PathCommandDocument[];
  readonly faces?: Readonly<
    Partial<
      Record<BoxFace, Partial<Omit<BoxFaceSettings, 'color'> & { color: string | null | ColorRef }>>
    >
  >;
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
  /**
   * Shape parameters: numbers the tree's values are computed from, overridden at build time
   * (`buildDocument`'s `params`, the player's `params` option).
   */
  readonly params?: Readonly<Record<string, ShapeParam>>;
  /**
   * Palettes: CSS colors by role (`body`, `belly`, `eyes`), which colors in the tree refer to.
   * The first is the base, with every role; the others (`dark`, a brand) may name only some,
   * the rest coming from the base. A built mascot switches between them on the fly.
   */
  readonly palettes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The document's own prefabs, by name, next to the library's; one with a library name replaces it. */
  readonly prefabs?: Readonly<Record<string, PrefabDocument>>;
  /**
   * The archetype (`ARCHETYPES` in `@mascotte/library`): the rig binds its slots, and library
   * motions measure the mascot's size by it.
   */
  readonly archetype?: string;
  /** The frame size in CSS pixels (before devicePixelRatio) and its background color. */
  readonly view: { readonly width: number; readonly height: number; readonly background?: string };
  /** Camera properties by registry name (`zoom`, `projection`, `distance`, …). */
  readonly camera?: { readonly props?: Readonly<Record<string, PlainValue>> };
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
