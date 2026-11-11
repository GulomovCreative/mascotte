import {
  type Euler,
  type EulerOrder,
  euler,
  type Mat3x4,
  mat3x4,
  type Quat,
  quat,
  type Vec3,
  vec3,
} from '@mascotte/math';
import type { Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { copyTarget, lookupTarget, type Target, type TargetScope, targetName } from './rig.ts';
import { pivotOf, turnInParent, turnNode } from './turn.ts';

/*
 * Constraints: rules that adjust the animated pose of rig nodes every frame, after the layers
 * and before springs, in the order the animator lists them (an explicit order, which the
 * document will save): a later constraint sees what earlier ones did.
 * - `aim` turns a node by the smallest rotation that points one of its axes at a goal (eyes,
 *   a head following the pointer); the roll of the pose is kept;
 * - `lookAt` points an axis at the goal and keeps another axis as upright as it can, so the
 *   node does not roll;
 * - `twoBoneIK` bends a chain of two bones (an arm, a leg) so that a point of the second one
 *   reaches the goal, bending towards a pole node or keeping the bend of the pose;
 * - `copyTransform` copies the local position, rotation and scale of another node;
 * - `limitRotation` keeps the node's local rotation, as Euler angles, within ranges.
 *
 * A goal is a node (`at`, its pivot) or a world point (`point`, in the spec or set later, e.g.
 * from the pointer); the choice between the two is fixed when the constraint is made. An
 * `aim`, `lookAt` or `twoBoneIK` without one leaves the pose alone. Each constraint has a
 * `weight` (0 shows the pose, 1 the constraint): `aim` and `lookAt` turn that fraction of
 * their angle, which they also limit (`maxAngle`, from the rotation the node has when the
 * constraint runs), and the others blend the local values they write from the pose.
 * Constraints keep no state, so seeking stays exact; they use shared scratch vectors, and
 * writing their properties only boxes a few numbers, which the allocation test bounds. They
 * leave the pose alone where it has no answer: a goal at the node's pivot, an ancestor with
 * scale 0, a bone of no length.
 *
 * A constraint is made from plain data (a spec, which the document will save) by
 * `Animator.addConstraint`, which resolves its nodes (ids or rig slots) and owns the
 * properties it writes, so it starts from the pose every frame. `weight`, `enabled`, `point`
 * and `maxAngle` change at run time and are not part of the spec: `toSpec()` gives the spec
 * the constraint was made from. Other edits go through an edited spec and
 * `Animator.replaceConstraint`. While one of its nodes is destroyed or out of the scene, or its
 * nodes no longer hold together (a chain's second bone has left the first one's subtree, a
 * goal or pole node has moved under the target), a constraint does nothing and says why in
 * `problem`; after the tree or the rig's slots change it resolves its targets again and moves
 * to the nodes they name now, like a spring.
 */

/** All constraint kinds. */
export const CONSTRAINT_KINDS = [
  'aim',
  'lookAt',
  'twoBoneIK',
  'copyTransform',
  'limitRotation',
] as const;

export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

interface SpecBase {
  /** The node the constraint changes: an id or a rig slot. */
  readonly target: Target;
  /** From 0 (the pose) to 1 (the constraint). Default 1. */
  readonly weight?: number;
  /** Whether the constraint runs. Default true. */
  readonly enabled?: boolean;
}

/** Where a node is turned to: a node's pivot (`at`), or a world point (`point`), not both. */
interface GoalOptions {
  /** A node whose pivot is the goal: an id or a rig slot. */
  readonly at?: Target | null;
  /** A world point as the goal; can be set later (`constraint.point`). */
  readonly point?: Readonly<Vec3> | null;
}

/** Turns `target` so that its `axis` points at the goal, by the smallest rotation. */
export interface AimSpec extends SpecBase, GoalOptions {
  readonly kind: 'aim';
  /** The axis in the node's coordinates. Default z, towards the viewer at rest. */
  readonly axis?: Readonly<Vec3>;
  /**
   * The largest turn, in radians, from the rotation the node has when the constraint runs
   * (the pose after earlier constraints): above 0 and at most π. Default π.
   */
  readonly maxAngle?: number;
}

/** Points `target`'s `axis` at the goal and keeps its `up` axis as close to `worldUp` as it can. */
export interface LookAtSpec extends SpecBase, GoalOptions {
  readonly kind: 'lookAt';
  /** The axis in the node's coordinates. Default z. */
  readonly axis?: Readonly<Vec3>;
  /** The node's up axis, not along `axis`. Default −y (up, since y goes down). */
  readonly up?: Readonly<Vec3>;
  /** The world direction `up` follows. Default −y. */
  readonly worldUp?: Readonly<Vec3>;
  /** The largest turn from the rotation the node has, as for `aim`. Default π. */
  readonly maxAngle?: number;
}

/**
 * Bends the chain `target` (the first bone) → `mid` (the second, a descendant of the first)
 * so that point `tip` of `mid` reaches the goal. The distance to the goal is kept within what
 * the bones span (from the difference of their lengths to their sum); the bones keep their
 * lengths and the twist of the pose. The chain is solved in the space of the target's parent,
 * so any scale above the chain is fine; scale that is not uniform inside the chain (on the
 * target or between it and `mid`) makes the tip miss.
 */
export interface TwoBoneIKSpec extends SpecBase, GoalOptions {
  readonly kind: 'twoBoneIK';
  /** The second bone: an id or a rig slot. */
  readonly mid: Target;
  /** The end of the chain in `mid`'s coordinates (a hand, a foot); not its pivot. */
  readonly tip: Readonly<Vec3>;
  /**
   * A node whose pivot the middle joint bends towards. Without it, or when it lies on the line
   * from the root to the goal, the joint bends the way it sticks out of the line from the root
   * to the tip in the pose; a straight limb bends in the plane of the limb and the goal.
   */
  readonly pole?: Target | null;
}

/** Copies the local position, rotation and scale of `from` (each can be turned off). */
export interface CopyTransformSpec extends SpecBase {
  readonly kind: 'copyTransform';
  /** The node to copy: an id or a rig slot. */
  readonly from: Target;
  /** Default true. */
  readonly position?: boolean;
  /** Default true. */
  readonly rotation?: boolean;
  /** Default true. */
  readonly scale?: boolean;
}

/**
 * Keeps the local rotation, as Euler angles in `order`, between `min` and `max` (radians).
 * The middle axis of the order spans only [−π/2, π/2], so its bounds lie there. Both Euler
 * forms of a rotation are clamped and the result nearer the pose is kept, and an angle out of
 * its range goes to the nearer bound around the circle, so poses near ±π/2 on the middle axis
 * or ±π on the others do not jump. Far out of range the nearest allowed rotation can switch
 * to another one, as with any limit that is not convex.
 */
export interface LimitRotationSpec extends SpecBase {
  readonly kind: 'limitRotation';
  /** Lower bounds per axis, from −π (−π/2 on the middle axis); default the lowest. */
  readonly min?: Partial<Readonly<Vec3>>;
  /** Upper bounds per axis, up to π (π/2 on the middle axis); default the highest. */
  readonly max?: Partial<Readonly<Vec3>>;
  /** Euler order. Default `XYZ`. */
  readonly order?: EulerOrder;
}

export type ConstraintSpec =
  | AimSpec
  | LookAtSpec
  | TwoBoneIKSpec
  | CopyTransformSpec
  | LimitRotationSpec;

/** A node property a constraint writes; the animator owns it. */
export interface Written {
  readonly node: Node;
  readonly property: 'position' | 'rotation' | 'scale';
}

type SpecOf<K extends ConstraintKind> = Extract<ConstraintSpec, { kind: K }>;

/** The options of each kind, checked against the spec types both ways by the compiler. */
const KEYS = {
  aim: ['kind', 'target', 'weight', 'enabled', 'at', 'point', 'axis', 'maxAngle'],
  lookAt: [
    'kind',
    'target',
    'weight',
    'enabled',
    'at',
    'point',
    'axis',
    'up',
    'worldUp',
    'maxAngle',
  ],
  twoBoneIK: ['kind', 'target', 'weight', 'enabled', 'at', 'point', 'mid', 'tip', 'pole'],
  copyTransform: ['kind', 'target', 'weight', 'enabled', 'from', 'position', 'rotation', 'scale'],
  limitRotation: ['kind', 'target', 'weight', 'enabled', 'min', 'max', 'order'],
} as const satisfies { readonly [K in ConstraintKind]: readonly (keyof SpecOf<K>)[] };

// Fails to compile when a spec gains an option the table above does not list.
type Unlisted = {
  [K in ConstraintKind]: Exclude<keyof SpecOf<K>, (typeof KEYS)[K][number]>;
}[ConstraintKind];
const everyOptionListed: [Unlisted] extends [never] ? true : never = true;
void everyOptionListed;

/** Names a constraint in messages: `Constraint aim [head]:`. */
interface Named {
  readonly kind: string;
  readonly target: Target;
}

function fail(named: Named, message: string): never {
  throw new RangeError(`Constraint ${String(named.kind)} ${targetName(named.target)}: ${message}`);
}

function checkWeight(named: Named, value: unknown): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
    fail(named, `weight must be a number from 0 to 1, got ${String(value)}.`);
  }
  return value;
}

function checkMaxAngle(named: Named, value: unknown): number {
  if (typeof value !== 'number' || !(value > 0 && value <= Math.PI)) {
    fail(named, `maxAngle must be a number above 0 and at most π, got ${String(value)}.`);
  }
  return value;
}

/*
 * In specs, a missing option and `null` both mean the default, as JSON writes it. Values
 * are checked for their type, not converted.
 */

function checkBoolean(named: Named, name: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    fail(named, `${name} must be true or false, got ${String(value)}.`);
  }
  return value;
}

function isFiniteVec(value: unknown): value is Readonly<Vec3> {
  const v = value as Vec3;
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

function checkPoint(named: Named, name: string, value: unknown): Readonly<Vec3> {
  if (!isFiniteVec(value)) fail(named, `${name} must be a vector {x, y, z} of finite numbers.`);
  return value;
}

/** A frozen unit vector from `value`, or (x, y, z) when it is not given. */
function direction(
  named: Named,
  name: string,
  value: unknown,
  x: number,
  y: number,
  z: number,
): Readonly<Vec3> {
  if (value === undefined || value === null) return Object.freeze(vec3.create(x, y, z));
  const length = isFiniteVec(value) ? vec3.length(value) : 0;
  if (!(length > 0 && Number.isFinite(length))) {
    fail(named, `${name} must be a non-zero vector {x, y, z} of finite numbers.`);
  }
  return Object.freeze(vec3.normalize(vec3.create(), value as Readonly<Vec3>));
}

function isTarget(value: unknown): value is Target {
  if (typeof value === 'string') return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { slot?: unknown }).slot === 'string'
  );
}

/** `value` as a required target named `name`, or a RangeError naming the constraint. */
function requireTarget(named: Named, name: string, value: unknown): Target {
  if (!isTarget(value)) fail(named, `${name} is required: a node id or a slot reference { slot }.`);
  return copyTarget(value);
}

/** `value` as an optional target named `name` (`null` when absent). */
function optionalTarget(named: Named, name: string, value: unknown): Target | null {
  if (value === undefined || value === null) return null;
  if (!isTarget(value)) {
    fail(
      named,
      `${name} must be a node id or a slot reference { slot }, got ${targetName(value as Target)}.`,
    );
  }
  return copyTarget(value);
}

/**
 * The node `target` names in `scope`, or why there is none: prefixed by `what` and the
 * target's name, except for the constraint's own `target`, which its name already gives.
 */
function find(target: Target, scope: TargetScope, what: string): Node | string {
  const node = lookupTarget(target, scope);
  if (typeof node !== 'string') return node;
  return what === 'target' ? node : `${what} ${targetName(target)}: ${node}`;
}

/** Whether `node` turns with `root`: it is `root` or one of its descendants. */
function turnsWith(node: Node, root: Node): boolean {
  return node === root || root.isAncestorOf(node);
}

/**
 * Resolves `target`, named `what`, into `nodes`. It must not turn with `root`, so it may be
 * neither `root` nor one of its descendants; an error message or null.
 */
function findOutside(
  target: Target,
  scope: TargetScope,
  what: string,
  root: Node,
  nodes: Node[],
): string | null {
  const node = find(target, scope, what);
  if (typeof node === 'string') return node;
  if (turnsWith(node, root)) {
    return `${what} ${targetName(target)} must not be the target or under it: it would turn with it.`;
  }
  nodes.push(node);
  return null;
}

/** The binding of a constraint: nodes it reads and writes, or why it has none. */
type Found = { readonly nodes: readonly Node[] } | { readonly error: string };

const center = vec3.create();
const goal = vec3.create();
const axisWorld = vec3.create();
const a = vec3.create();
const b = vec3.create();
const c = vec3.create();
const bend = vec3.create();
const knee = vec3.create();
const end = vec3.create();
const toGoal = vec3.create();
const forward = vec3.create();
const upRef = vec3.create();
const upNow = vec3.create();
const crossed = vec3.create();
const inverse: Mat3x4 = mat3x4.create();
const pose: Quat = quat.create();
const poseMid: Quat = quat.create();
const result: Quat = quat.create();
const other: Quat = quat.create();
const twist: Quat = quat.create();
const angles: Euler = euler.create();
const alternate: Euler = euler.create();
const scratch: Vec3 = vec3.create();

/** Constraint internals for the animator; filled in the static block of `BaseConstraint`. */
let constraintInternals!: {
  apply(constraint: BaseConstraint): void;
  written(constraint: BaseConstraint): readonly Written[];
  rebind(constraint: BaseConstraint, scope: TargetScope): boolean;
};

/** What every constraint has; see the kinds' classes. */
abstract class BaseConstraint {
  readonly kind: ConstraintKind;
  /** The node the constraint changes: an id or a rig slot. */
  readonly target: Target;
  #weight: number;
  #enabled: boolean;
  #nodes: readonly Node[] = [];
  #written: readonly Written[] = [];
  #scene: Scene | null = null;
  /** The spec the constraint was made from, with defaults written out. */
  #spec: ConstraintSpec | null = null;
  /** Why the last attempt to resolve the nodes again failed. */
  #failure: string | null = null;

  protected constructor(spec: ConstraintSpec) {
    this.kind = spec.kind;
    this.target = requireTarget(spec, 'target', spec.target);
    this.#weight = checkWeight(spec, spec.weight ?? 1);
    this.#enabled = checkBoolean(spec, 'enabled', spec.enabled, true);
  }

  /** From 0 (the pose) to 1 (the constraint). */
  get weight(): number {
    return this.#weight;
  }
  set weight(value: number) {
    this.#weight = checkWeight(this, value);
  }

  /** Whether the constraint runs; a disabled one leaves the pose alone. */
  get enabled(): boolean {
    return this.#enabled;
  }
  set enabled(value: boolean) {
    if (typeof value !== 'boolean') {
      fail(this, `enabled must be true or false, got ${String(value)}.`);
    }
    this.#enabled = value;
  }

  /**
   * The node the constraint changes: the one its target named when it was last bound (it may
   * be gone; see `problem`).
   */
  get node(): Node {
    return this.#nodes[0] as Node;
  }

  /**
   * The spec the constraint was made from, with defaults written out: what the document
   * saves. Changes at run time (`weight`, `enabled`, `point`, `maxAngle`) are not in it.
   */
  toSpec(): ConstraintSpec {
    return structuredClone(this.#spec as ConstraintSpec);
  }

  /**
   * Why the constraint does nothing although it is enabled, or `null` when it works: a node
   * that is gone (and, after a failed attempt to find its replacement, why that failed), or
   * a chain that does not hold together. Built when read.
   */
  get problem(): string | null {
    if (!this.#live) {
      const gone = this.#nodes.find((node) => node.scene !== this.#scene) as Node;
      const lost = `node "${gone.id}" is destroyed or out of the scene`;
      return this.#failure ? `${lost}, and ${this.#failure}` : `${lost}.`;
    }
    return this.intact ? null : this.brokenBecause();
  }

  /** The kind's fields of the spec it was made from, with defaults written out. */
  protected abstract describe(): Record<string, unknown>;

  /** Why `intact` is false. */
  protected brokenBecause(): string {
    return 'its nodes do not hold together.';
  }

  /** Resolves the nodes in `scope`: the target first, then the others the constraint reads. */
  protected abstract find(scope: TargetScope): Found;

  /** Takes the nodes `find` gave and gives the properties written. */
  protected abstract bind(nodes: readonly Node[]): readonly Written[];

  /** Applies the constraint to the current pose. */
  protected abstract run(weight: number): void;

  /** Whether the nodes still hold together (beyond being in the scene); true by default. */
  protected get intact(): boolean {
    return true;
  }

  /**
   * Resolves and binds the nodes, or throws naming the constraint, and records the spec. The
   * last step of every kind's constructor.
   */
  protected resolve(scope: TargetScope): void {
    const error = this.#tryResolve(scope);
    if (error !== null) fail(this, error);
    this.#spec = Object.freeze({
      kind: this.kind,
      target: this.target,
      weight: this.#weight,
      enabled: this.#enabled,
      ...this.describe(),
    }) as unknown as ConstraintSpec;
  }

  /** Binds the nodes `find` gives, all at once; null, or why they cannot be bound. */
  #tryResolve(scope: TargetScope): string | null {
    const found = this.find(scope);
    if ('error' in found) return found.error;
    this.#written = this.bind(found.nodes);
    this.#nodes = found.nodes;
    this.#scene = scope.scene;
    return null;
  }

  /** Whether every node is alive and in the scene the constraint was bound in. */
  get #live(): boolean {
    const nodes = this.#nodes;
    for (let i = 0; i < nodes.length; i++) {
      if ((nodes[i] as Node).scene !== this.#scene) return false;
    }
    return true;
  }

  static {
    constraintInternals = {
      apply(constraint) {
        const weight = constraint.#weight;
        if (!constraint.#enabled || weight === 0) return;
        if (!constraint.#live || !constraint.intact) return;
        constraint.run(weight);
      },
      written: (constraint) => constraint.#written,
      rebind(constraint, scope) {
        if (constraint.#live && constraint.intact) {
          constraint.#failure = null;
          return false;
        }
        constraint.#failure = constraint.#tryResolve(scope);
        return constraint.#failure === null;
      },
    };
  }
}

/** A constraint that turns its node towards a goal. */
abstract class GoalConstraint extends BaseConstraint {
  /** A node whose pivot is the goal, or `null`. */
  readonly at: Target | null;
  #point: Readonly<Vec3> | null = null;

  protected constructor(spec: AimSpec | LookAtSpec | TwoBoneIKSpec) {
    super(spec);
    const at = optionalTarget(spec, 'at', spec.at);
    const point = spec.point ?? null;
    if (at !== null && point !== null) fail(spec, 'give either at or point, not both.');
    this.at = at;
    if (point !== null) this.#point = Object.freeze(vec3.clone(checkPoint(spec, 'point', point)));
  }

  /**
   * The goal as a world point when there is no `at` node; `null` leaves the pose alone.
   * Setting stores a frozen copy; it throws for a constraint that follows an `at` node.
   */
  get point(): Readonly<Vec3> | null {
    return this.#point;
  }
  set point(value: Readonly<Vec3> | null) {
    if (this.at !== null) fail(this, `it follows ${targetName(this.at)}, so it has no point.`);
    this.#point =
      value === null ? null : Object.freeze(vec3.clone(checkPoint(this, 'point', value)));
  }

  /** Resolves `at` into `nodes` (see `findOutside`); an error message or null. */
  protected findGoal(scope: TargetScope, nodes: Node[], root: Node): string | null {
    return this.at === null ? null : findOutside(this.at, scope, 'at', root, nodes);
  }

  /** The `at` node once bound, or null. */
  protected abstract get atNode(): Node | null;

  /** Why `node`, a goal or pole, cannot be used with `root` now (it turns with it), or null. */
  protected static under(what: string, node: Node | null, root: Node): string | null {
    if (!node || !turnsWith(node, root)) return null;
    return `${what} "${node.id}" is the target "${root.id}" or under it: it would turn with it.`;
  }

  protected describeGoal(): Record<string, unknown> {
    if (this.at !== null) return { at: this.at };
    return this.#point ? { point: vec3.clone(this.#point) } : {};
  }

  /** Writes the goal into `out`; `false` when there is none. */
  protected goal(out: Vec3): boolean {
    const at = this.atNode;
    if (at) {
      pivotOf(out, at);
      return true;
    }
    const point = this.#point;
    if (!point) return false;
    vec3.copy(out, point);
    return true;
  }
}

/** `aim` and `lookAt`: a goal and an angle limit. */
abstract class TurnConstraint extends GoalConstraint {
  readonly axis: Readonly<Vec3>;
  #maxAngle: number;
  #at: Node | null = null;

  protected constructor(spec: AimSpec | LookAtSpec) {
    super(spec);
    this.axis = direction(spec, 'axis', spec.axis, 0, 0, 1);
    this.#maxAngle = checkMaxAngle(spec, spec.maxAngle ?? Math.PI);
  }

  /** The largest turn in radians, above 0 and at most π (from the spec, changeable). */
  get maxAngle(): number {
    return this.#maxAngle;
  }
  set maxAngle(value: number) {
    this.#maxAngle = checkMaxAngle(this, value);
  }

  protected get atNode(): Node | null {
    return this.#at;
  }

  protected override get intact(): boolean {
    const at = this.#at;
    return !at || !turnsWith(at, this.node);
  }

  protected override brokenBecause(): string {
    return GoalConstraint.under('at', this.#at, this.node) ?? super.brokenBecause();
  }

  protected find(scope: TargetScope): Found {
    const node = find(this.target, scope, 'target');
    if (typeof node === 'string') return { error: node };
    const nodes = [node];
    const error = this.findGoal(scope, nodes, node);
    return error ? { error } : { nodes };
  }

  protected bind(nodes: readonly Node[]): readonly Written[] {
    this.#at = nodes[1] ?? null;
    return [{ node: nodes[0] as Node, property: 'rotation' }];
  }

  protected describe(): Record<string, unknown> {
    return { ...this.describeGoal(), axis: vec3.clone(this.axis), maxAngle: this.#maxAngle };
  }
}

/** Points an axis at a goal by the smallest turn. See `AimSpec`. */
export class AimConstraint extends TurnConstraint {
  declare readonly kind: 'aim';

  /** Use `Animator.addConstraint`. */
  constructor(spec: AimSpec, scope: TargetScope) {
    super(spec);
    this.resolve(scope);
  }

  override toSpec(): AimSpec {
    return super.toSpec() as AimSpec;
  }

  protected run(weight: number): void {
    if (!this.goal(goal)) return;
    const node = this.node;
    pivotOf(center, node);
    vec3.sub(toGoal, goal, center);
    mat3x4.transformDirection(axisWorld, node.worldMatrix, this.axis);
    turnNode(node, axisWorld, toGoal, this.maxAngle, weight);
  }
}

/** Points an axis at a goal and keeps the node upright. See `LookAtSpec`. */
export class LookAtConstraint extends TurnConstraint {
  declare readonly kind: 'lookAt';
  readonly up: Readonly<Vec3>;
  readonly worldUp: Readonly<Vec3>;

  /** Use `Animator.addConstraint`. */
  constructor(spec: LookAtSpec, scope: TargetScope) {
    super(spec);
    this.up = direction(spec, 'up', spec.up, 0, -1, 0);
    this.worldUp = direction(spec, 'worldUp', spec.worldUp, 0, -1, 0);
    if (vec3.length(vec3.cross(scratch, this.axis, this.up)) < 1e-6) {
      fail(spec, 'up must not be along axis.');
    }
    this.resolve(scope);
  }

  override toSpec(): LookAtSpec {
    return super.toSpec() as LookAtSpec;
  }

  protected override describe(): Record<string, unknown> {
    return { ...super.describe(), up: vec3.clone(this.up), worldUp: vec3.clone(this.worldUp) };
  }

  protected run(weight: number): void {
    if (!this.goal(goal)) return;
    const node = this.node;
    pivotOf(center, node);
    vec3.sub(forward, goal, center);
    vec3.copy(upRef, this.worldUp);
    // Both directions in the parent's space, where the node's rotation applies.
    const parent = node.parent;
    if (parent) {
      if (!mat3x4.invert(inverse, parent.worldMatrix)) return;
      mat3x4.transformDirection(forward, inverse, forward);
      mat3x4.transformDirection(upRef, inverse, upRef);
    }
    if (vec3.length(forward) === 0) return;
    vec3.normalize(forward, forward);
    // Point the axis at the goal, then roll about it so that `up` comes closest to `upRef`.
    quat.rotationTo(result, this.axis, forward);
    quat.transformVec3(upNow, result, this.up);
    vec3.scaleAndAdd(upNow, upNow, forward, -vec3.dot(upNow, forward));
    vec3.scaleAndAdd(upRef, upRef, forward, -vec3.dot(upRef, forward));
    if (vec3.length(upNow) > 1e-9 && vec3.length(upRef) > 1e-9) {
      vec3.cross(crossed, upNow, upRef);
      const roll = Math.atan2(vec3.dot(crossed, forward), vec3.dot(upNow, upRef));
      quat.setAxisAngle(twist, forward, roll);
      quat.multiply(result, twist, result);
    }
    quat.copy(pose, node.rotation);
    const angle = quat.angleBetween(pose, result);
    const limited = Math.min(angle, this.maxAngle) * weight;
    if (!(limited > 0)) return;
    if (limited < angle) quat.slerp(result, pose, result, limited / angle);
    node.rotation.copy(result);
  }
}

/** Bends a chain of two bones to reach a goal. See `TwoBoneIKSpec`. */
export class TwoBoneIKConstraint extends GoalConstraint {
  declare readonly kind: 'twoBoneIK';
  /** The second bone: an id or a rig slot. */
  readonly mid: Target;
  readonly tip: Readonly<Vec3>;
  /** The node the middle joint bends towards, or `null`. */
  readonly pole: Target | null;
  #mid: Node | null = null;
  #at: Node | null = null;
  #pole: Node | null = null;

  /** Use `Animator.addConstraint`. */
  constructor(spec: TwoBoneIKSpec, scope: TargetScope) {
    super(spec);
    this.mid = requireTarget(spec, 'mid', spec.mid);
    if (spec.tip === undefined || spec.tip === null) {
      fail(spec, "tip is required: a point in mid's coordinates.");
    }
    this.tip = Object.freeze(vec3.clone(checkPoint(spec, 'tip', spec.tip)));
    this.pole = optionalTarget(spec, 'pole', spec.pole);
    this.resolve(scope);
  }

  /** The second bone (as for `node`, the one last bound). */
  get midNode(): Node {
    return this.#mid as Node;
  }

  protected get atNode(): Node | null {
    return this.#at;
  }

  protected override get intact(): boolean {
    const root = this.node;
    const at = this.#at;
    const pole = this.#pole;
    // Runs every frame: plain checks, no arrays.
    if (!root.isAncestorOf(this.#mid as Node)) return false;
    if (at && turnsWith(at, root)) return false;
    return !pole || !turnsWith(pole, root);
  }

  protected override brokenBecause(): string {
    const root = this.node;
    if (!root.isAncestorOf(this.midNode)) {
      return `mid "${this.midNode.id}" has left the subtree of the target "${root.id}".`;
    }
    return (
      GoalConstraint.under('at', this.#at, root) ??
      GoalConstraint.under('pole', this.#pole, root) ??
      super.brokenBecause()
    );
  }

  override toSpec(): TwoBoneIKSpec {
    return super.toSpec() as TwoBoneIKSpec;
  }

  protected describe(): Record<string, unknown> {
    const spec = { ...this.describeGoal(), mid: this.mid, tip: vec3.clone(this.tip) };
    return this.pole === null ? spec : { ...spec, pole: this.pole };
  }

  protected find(scope: TargetScope): Found {
    const root = find(this.target, scope, 'target');
    if (typeof root === 'string') return { error: root };
    const mid = find(this.mid, scope, 'mid');
    if (typeof mid === 'string') return { error: mid };
    if (!root.isAncestorOf(mid)) {
      return { error: `mid ${targetName(this.mid)} must be a descendant of the target.` };
    }
    const nodes = [root, mid];
    const error =
      this.findGoal(scope, nodes, root) ??
      (this.pole === null ? null : findOutside(this.pole, scope, 'pole', root, nodes));
    return error ? { error } : { nodes };
  }

  protected bind(nodes: readonly Node[]): readonly Written[] {
    const root = nodes[0] as Node;
    const mid = nodes[1] as Node;
    this.#mid = mid;
    // After the chain come `at` and then `pole`, each when given.
    let next = 2;
    this.#at = this.at === null ? null : (nodes[next++] as Node);
    this.#pole = this.pole === null ? null : (nodes[next] as Node);
    return [
      { node: root, property: 'rotation' },
      { node: mid, property: 'rotation' },
    ];
  }

  protected run(weight: number): void {
    if (!this.goal(goal)) return;
    const root = this.node;
    const mid = this.#mid as Node;
    const pole = this.#pole;
    pivotOf(a, root);
    pivotOf(b, mid);
    mid.localToWorld(c, this.tip);
    if (pole) pivotOf(bend, pole);
    // The triangle is solved in the space of the root's parent, where the root turns: lengths
    // there stay as they are under any scale above the chain.
    const parent = root.parent;
    if (parent) {
      if (!mat3x4.invert(inverse, parent.worldMatrix)) return;
      mat3x4.transformPoint(a, inverse, a);
      mat3x4.transformPoint(b, inverse, b);
      mat3x4.transformPoint(c, inverse, c);
      mat3x4.transformPoint(goal, inverse, goal);
      if (pole) mat3x4.transformPoint(bend, inverse, bend);
    }
    const upper = vec3.distance(a, b);
    const lower = vec3.distance(b, c);
    vec3.sub(toGoal, goal, a);
    let reach = vec3.length(toGoal);
    if (upper === 0 || lower === 0 || reach === 0) return;
    vec3.scale(toGoal, toGoal, 1 / reach);
    // The tip goes as far as the bones span: from the difference of their lengths to the sum.
    reach = Math.min(Math.max(reach, Math.abs(upper - lower) + 1e-9), upper + lower);
    // The bend, across the line to the goal: towards the pole, or the way the joint sticks out
    // of the line from the root to the tip in the pose.
    if (pole) {
      vec3.sub(bend, bend, a);
      vec3.scaleAndAdd(bend, bend, toGoal, -vec3.dot(bend, toGoal));
    }
    if (!pole || vec3.length(bend) < 1e-9 * upper) {
      vec3.sub(bend, b, a);
      vec3.sub(scratch, c, a);
      const lengthSq = vec3.dot(scratch, scratch);
      if (lengthSq > 0) vec3.scaleAndAdd(bend, bend, scratch, -vec3.dot(bend, scratch) / lengthSq);
      vec3.scaleAndAdd(bend, bend, toGoal, -vec3.dot(bend, toGoal));
      if (vec3.length(bend) < 1e-9 * upper) {
        // A straight limb: bend in the plane of the limb and the goal.
        vec3.sub(bend, b, a);
        vec3.scaleAndAdd(bend, bend, toGoal, -vec3.dot(bend, toGoal));
        if (vec3.length(bend) < 1e-9 * upper) perpendicular(bend, toGoal);
      }
    }
    vec3.normalize(bend, bend);
    // The knee from the triangle of the two bones and the reach.
    const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
    const across = Math.sqrt(Math.max(0, upper * upper - along * along));
    vec3.scaleAndAdd(knee, a, toGoal, along);
    vec3.scaleAndAdd(knee, knee, bend, across);
    vec3.scaleAndAdd(end, a, toGoal, reach);
    quat.copy(pose, root.rotation);
    quat.copy(poseMid, mid.rotation);
    vec3.sub(b, b, a);
    vec3.sub(knee, knee, a);
    turnInParent(root, b, knee);
    // The second bone turns in its own parent's space: back to the world for `turnNode`.
    if (parent) mat3x4.transformPoint(end, parent.worldMatrix, end);
    pivotOf(b, mid);
    mid.localToWorld(c, this.tip);
    vec3.sub(c, c, b);
    vec3.sub(end, end, b);
    turnNode(mid, c, end);
    if (weight < 1) {
      quat.slerp(result, pose, root.rotation, weight);
      root.rotation.copy(result);
      quat.slerp(result, poseMid, mid.rotation, weight);
      mid.rotation.copy(result);
    }
  }
}

/** A unit vector perpendicular to unit `v`. */
function perpendicular(out: Vec3, v: Readonly<Vec3>): Vec3 {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ax <= ay && ax <= az) vec3.set(scratch, 1, 0, 0);
  else if (ay <= az) vec3.set(scratch, 0, 1, 0);
  else vec3.set(scratch, 0, 0, 1);
  return vec3.normalize(out, vec3.cross(out, v, scratch));
}

/** Copies another node's local transform. See `CopyTransformSpec`. */
export class CopyTransformConstraint extends BaseConstraint {
  declare readonly kind: 'copyTransform';
  /** The node copied: an id or a rig slot. */
  readonly from: Target;
  readonly position: boolean;
  readonly rotation: boolean;
  readonly scale: boolean;
  #from: Node | null = null;

  /** Use `Animator.addConstraint`. */
  constructor(spec: CopyTransformSpec, scope: TargetScope) {
    super(spec);
    this.from = requireTarget(spec, 'from', spec.from);
    this.position = checkBoolean(spec, 'position', spec.position, true);
    this.rotation = checkBoolean(spec, 'rotation', spec.rotation, true);
    this.scale = checkBoolean(spec, 'scale', spec.scale, true);
    if (!(this.position || this.rotation || this.scale)) {
      fail(spec, 'it copies nothing: position, rotation and scale are all off.');
    }
    this.resolve(scope);
  }

  /** The node copied. */
  get fromNode(): Node {
    return this.#from as Node;
  }

  override toSpec(): CopyTransformSpec {
    return super.toSpec() as CopyTransformSpec;
  }

  protected describe(): Record<string, unknown> {
    const { from, position, rotation, scale } = this;
    return { from, position, rotation, scale };
  }

  protected find(scope: TargetScope): Found {
    const node = find(this.target, scope, 'target');
    if (typeof node === 'string') return { error: node };
    const from = find(this.from, scope, 'from');
    if (typeof from === 'string') return { error: from };
    if (from === node) return { error: 'a node cannot copy itself.' };
    return { nodes: [node, from] };
  }

  protected bind(nodes: readonly Node[]): readonly Written[] {
    const node = nodes[0] as Node;
    this.#from = nodes[1] as Node;
    const written: Written[] = [];
    if (this.position) written.push({ node, property: 'position' });
    if (this.rotation) written.push({ node, property: 'rotation' });
    if (this.scale) written.push({ node, property: 'scale' });
    return written;
  }

  protected run(weight: number): void {
    const node = this.node;
    const from = this.#from as Node;
    if (this.position) {
      vec3.lerp(scratch, node.position, from.position, weight);
      node.position.copy(scratch);
    }
    if (this.rotation) {
      quat.slerp(result, node.rotation, from.rotation, weight);
      node.rotation.copy(result);
    }
    if (this.scale) {
      vec3.lerp(scratch, node.scale, from.scale, weight);
      node.scale.copy(scratch);
    }
  }
}

const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];

/** Wraps an angle into (−π, π]. */
function wrap(angle: number): number {
  if (angle > Math.PI) return angle - 2 * Math.PI;
  if (angle <= -Math.PI) return angle + 2 * Math.PI;
  return angle;
}

/** Keeps Euler angles of the local rotation within ranges. See `LimitRotationSpec`. */
export class LimitRotationConstraint extends BaseConstraint {
  declare readonly kind: 'limitRotation';
  readonly min: Readonly<Vec3>;
  readonly max: Readonly<Vec3>;
  readonly order: EulerOrder;
  readonly #first: Axis;
  readonly #middle: Axis;
  readonly #last: Axis;

  /** Use `Animator.addConstraint`. */
  constructor(spec: LimitRotationSpec, scope: TargetScope) {
    super(spec);
    const order = spec.order ?? 'XYZ';
    if (typeof order !== 'string' || !euler.isEulerOrder(order)) {
      fail(spec, `unknown Euler order "${String(order)}".`);
    }
    this.order = order;
    const [first, middle, last] = [...order.toLowerCase()] as Axis[];
    this.#first = first as Axis;
    this.#middle = middle as Axis;
    this.#last = last as Axis;
    const min = vec3.create();
    const max = vec3.create();
    for (const [name, bounds] of [
      ['min', spec.min],
      ['max', spec.max],
    ] as const) {
      if (bounds === undefined || bounds === null) continue;
      if (typeof bounds !== 'object') {
        fail(spec, `${name} must be an object with x, y or z.`);
      }
      for (const key of Object.keys(bounds)) {
        if (!(AXES as readonly string[]).includes(key)) {
          fail(spec, `${name} has an unknown axis "${key}" (known: x, y, z).`);
        }
      }
    }
    for (const axis of AXES) {
      const limit = axis === this.#middle ? Math.PI / 2 : Math.PI;
      const lo = spec.min?.[axis] ?? -limit;
      const hi = spec.max?.[axis] ?? limit;
      if (!(typeof lo === 'number' && typeof hi === 'number' && lo >= -limit && hi <= limit)) {
        const range =
          axis === this.#middle ? `[−π/2, π/2] (the middle axis of ${order})` : '[−π, π]';
        fail(
          spec,
          `the ${axis} bounds must be numbers within ${range}, got [${String(lo)}, ${String(hi)}].`,
        );
      }
      if (lo > hi) fail(spec, `the ${axis} bounds have min ${lo} above max ${hi}.`);
      min[axis] = lo;
      max[axis] = hi;
    }
    this.min = Object.freeze(min);
    this.max = Object.freeze(max);
    this.resolve(scope);
  }

  override toSpec(): LimitRotationSpec {
    return super.toSpec() as LimitRotationSpec;
  }

  protected describe(): Record<string, unknown> {
    return { min: vec3.clone(this.min), max: vec3.clone(this.max), order: this.order };
  }

  protected find(scope: TargetScope): Found {
    const node = find(this.target, scope, 'target');
    return typeof node === 'string' ? { error: node } : { nodes: [node] };
  }

  protected bind(nodes: readonly Node[]): readonly Written[] {
    return [{ node: nodes[0] as Node, property: 'rotation' }];
  }

  /**
   * Clamps `e` into the ranges; whether anything changed. An angle out of its range goes to
   * the nearer bound around the circle, so a pose crossing ±π does not jump across the range.
   */
  #clamp(e: Euler): boolean {
    const { min, max } = this;
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const axis = AXES[i] as Axis;
      const value = e[axis];
      const lo = min[axis];
      const hi = max[axis];
      if (value >= lo && value <= hi) continue;
      e[axis] = Math.abs(wrap(value - lo)) <= Math.abs(wrap(value - hi)) ? lo : hi;
      changed = true;
    }
    return changed;
  }

  protected run(weight: number): void {
    const node = this.node;
    angles.order = this.order;
    quat.toEuler(angles, node.rotation);
    // The same rotation in its other Euler form: the outer angles turned by π, the middle one
    // mirrored. Clamping each form and keeping the result nearer to the pose avoids jumps.
    alternate.order = this.order;
    alternate[this.#first] = wrap(angles[this.#first] + Math.PI);
    alternate[this.#middle] = wrap(Math.PI - angles[this.#middle]);
    alternate[this.#last] = wrap(angles[this.#last] + Math.PI);
    if (!this.#clamp(angles)) return;
    quat.copy(pose, node.rotation);
    quat.fromEuler(result, angles);
    this.#clamp(alternate);
    quat.fromEuler(other, alternate);
    if (quat.angleBetween(pose, other) < quat.angleBetween(pose, result)) quat.copy(result, other);
    if (weight < 1) quat.slerp(result, pose, result, weight);
    node.rotation.copy(result);
  }
}

/** A constraint of any kind; `kind` tells them apart. */
export type Constraint =
  | AimConstraint
  | LookAtConstraint
  | TwoBoneIKConstraint
  | CopyTransformConstraint
  | LimitRotationConstraint;

/** The constraint `Animator.addConstraint` creates from a spec of type `S`. */
export type ConstraintOf<S extends ConstraintSpec> = S extends AimSpec
  ? AimConstraint
  : S extends LookAtSpec
    ? LookAtConstraint
    : S extends TwoBoneIKSpec
      ? TwoBoneIKConstraint
      : S extends CopyTransformSpec
        ? CopyTransformConstraint
        : S extends LimitRotationSpec
          ? LimitRotationConstraint
          : Constraint;

/**
 * Creates a constraint from `spec`, resolving its nodes in `scope` (used by
 * `Animator.addConstraint`). Throws a TypeError for a spec that is not an object, and a
 * RangeError naming the constraint for an unknown kind or option, a missing or unresolved
 * target, or an invalid parameter.
 */
export function createConstraint(spec: ConstraintSpec, scope: TargetScope): Constraint {
  if (typeof spec !== 'object' || spec === null) {
    throw new TypeError(`A constraint spec must be an object, got ${String(spec)}.`);
  }
  const kind = (spec as { kind: unknown }).kind;
  if (!(CONSTRAINT_KINDS as readonly unknown[]).includes(kind)) {
    fail(spec, `unknown kind "${String(kind)}" (known: ${CONSTRAINT_KINDS.join(', ')}).`);
  }
  const known: readonly string[] = KEYS[spec.kind];
  for (const key of Object.keys(spec)) {
    if (!known.includes(key)) {
      fail(spec, `unknown option "${key}" (known: ${known.slice(1).join(', ')}).`);
    }
  }
  switch (spec.kind) {
    case 'aim':
      return new AimConstraint(spec, scope);
    case 'lookAt':
      return new LookAtConstraint(spec, scope);
    case 'twoBoneIK':
      return new TwoBoneIKConstraint(spec, scope);
    case 'copyTransform':
      return new CopyTransformConstraint(spec, scope);
    case 'limitRotation':
      return new LimitRotationConstraint(spec, scope);
  }
}

/** Applies `constraint` to the pose, unless it is off or one of its nodes is gone. */
export function applyConstraint(constraint: Constraint): void {
  constraintInternals.apply(constraint);
}

/** The node properties `constraint` writes now. */
export function writtenBy(constraint: Constraint): readonly Written[] {
  return constraintInternals.written(constraint);
}

/**
 * Resolves the targets of `constraint` again when one of its nodes is gone, and binds it to
 * the nodes they name now; whether it moved.
 */
export function rebindConstraint(constraint: Constraint, scope: TargetScope): boolean {
  return constraintInternals.rebind(constraint, scope);
}
