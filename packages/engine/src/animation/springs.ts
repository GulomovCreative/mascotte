import { type Mat3x4, mat3x4, type Quat, quat, type Vec3, vec3 } from '@mascotte/math';
import type { Node } from '../scene/node.ts';

/*
 * Springs: secondary motion for ears, tails and antennae. A spring hangs on a node and
 * follows a point of it, the `tip`, with inertia: a particle in world space is pulled to
 * where the animated pose puts the tip, and the node is turned about its pivot so that the
 * tip points at the particle. When the node or one of its ancestors moves, the tip lags
 * behind and swings past the pose when the motion stops.
 *
 * The particle is a damped spring (`frequency` in oscillations per second, `damping` as a
 * ratio: 0 swings forever, 1 settles without swinging past) simulated at a fixed step of
 * `SPRING_STEP` seconds, so the motion does not depend on the frame rate. Within a frame the
 * pulling point moves linearly from the previous frame's tip to the current one, and the
 * particle is shown moved on by its velocity for the time not simulated yet (less than a
 * step).
 *
 * Springs keep state, so unlike clips they depend on the frames played before, not only on
 * the time: playing the same frames again gives the same motion, and seeking does not.
 */

/** Simulation step of springs in seconds. */
export const SPRING_STEP = 1 / 120;

/** A frame longer than this (a hitch or a jump) settles springs instead of simulating it. */
export const SPRING_MAX_DT = 0.25;

/** The highest spring frequency: above it a step of `SPRING_STEP` is not stable. */
export const SPRING_MAX_FREQUENCY = 20;

export interface SpringOptions {
  /** Id of the node the spring turns. */
  readonly target: string;
  /** The point of the node, in its own coordinates, that lags behind; not the pivot. */
  readonly tip: Readonly<Vec3>;
  /** Oscillations per second, from 0 to `SPRING_MAX_FREQUENCY`. Default 2. */
  readonly frequency?: number;
  /** Damping ratio: 0 swings forever, 1 settles without overshoot. Default 0.3. */
  readonly damping?: number;
  /** The largest turn from the pose in radians, from 0 to π. Default π (no limit). */
  readonly maxAngle?: number;
}

function fail(target: string, message: string): never {
  throw new RangeError(`Spring ${target}: ${message}`);
}

function checkFrequency(target: string, value: number): number {
  if (!(value > 0 && value <= SPRING_MAX_FREQUENCY)) {
    fail(target, `frequency must be above 0 and at most ${SPRING_MAX_FREQUENCY}, got ${value}.`);
  }
  return value;
}

function checkDamping(target: string, value: number): number {
  if (!(value >= 0 && Number.isFinite(value))) {
    fail(target, `damping must be a finite non-negative number, got ${value}.`);
  }
  return value;
}

function checkMaxAngle(target: string, value: number): number {
  if (!(value > 0 && value <= Math.PI)) {
    fail(target, `maxAngle must be above 0 and at most π, got ${value}.`);
  }
  return value;
}

const goal = vec3.create();
const center = vec3.create();
const shown = vec3.create();
const toGoal = vec3.create();
const toShown = vec3.create();
const inverse: Mat3x4 = mat3x4.create();
const turn: Quat = quat.create();
const IDENTITY: Readonly<Quat> = quat.create();

let springInternals!: {
  step(spring: Spring, dt: number): void;
  apply(spring: Spring): void;
};

/** A spring on a node. Created by `Animator.addSpring`. */
export class Spring {
  readonly node: Node;
  readonly tip: Readonly<Vec3>;
  #frequency: number;
  #damping: number;
  #maxAngle: number;
  /** Whether the particle state is valid; after a reset it is placed at the tip. */
  #settled = false;
  /** The particle after the last step, in world space. */
  readonly #position = vec3.create();
  readonly #velocity = vec3.create();
  /** The tip of the pose at the end of the last frame. */
  readonly #goal = vec3.create();
  /** Time simulated less than the frames played, from 0 to one step. */
  #lag = 0;

  constructor(node: Node, options: SpringOptions) {
    const { target, tip } = options;
    if (!(Number.isFinite(tip.x) && Number.isFinite(tip.y) && Number.isFinite(tip.z))) {
      fail(target, 'tip must have finite coordinates.');
    }
    if (tip.x === node.pivot.x && tip.y === node.pivot.y && tip.z === node.pivot.z) {
      fail(target, 'tip must differ from the pivot.');
    }
    this.node = node;
    this.tip = vec3.clone(tip);
    this.#frequency = checkFrequency(target, options.frequency ?? 2);
    this.#damping = checkDamping(target, options.damping ?? 0.3);
    this.#maxAngle = checkMaxAngle(target, options.maxAngle ?? Math.PI);
  }

  get frequency(): number {
    return this.#frequency;
  }
  set frequency(value: number) {
    this.#frequency = checkFrequency(this.node.id, value);
  }

  get damping(): number {
    return this.#damping;
  }
  set damping(value: number) {
    this.#damping = checkDamping(this.node.id, value);
  }

  get maxAngle(): number {
    return this.#maxAngle;
  }
  set maxAngle(value: number) {
    this.#maxAngle = checkMaxAngle(this.node.id, value);
  }

  /** Puts the spring at rest: on the next frame the tip is where the pose puts it. */
  reset(): void {
    this.#settled = false;
  }

  #settle(tip: Readonly<Vec3>): void {
    vec3.copy(this.#position, tip);
    vec3.copy(this.#goal, tip);
    vec3.set(this.#velocity, 0, 0, 0);
    this.#lag = 0;
    this.#settled = true;
  }

  /** Simulates `dt` seconds towards the tip of the current pose. */
  #step(dt: number): void {
    if (this.node.destroyed) return;
    this.node.localToWorld(goal, this.tip);
    if (!this.#settled || dt > SPRING_MAX_DT) {
      this.#settle(goal);
      return;
    }
    if (!(dt > 0)) return;
    const h = SPRING_STEP;
    const omega = 2 * Math.PI * this.#frequency;
    const stiffness = omega * omega * h;
    const damping = 1 + 2 * this.#damping * omega * h;
    const p = this.#position;
    const v = this.#velocity;
    const from = this.#goal;
    let lag = this.#lag + dt;
    // The small margin keeps frames of a whole number of steps from leaving one step behind.
    const steps = Math.floor(lag / h + 1e-9);
    for (let k = 1; k <= steps; k++) {
      // The pulling point at the end of step k, moving from the previous tip to this one.
      const u = Math.min(1, Math.max(0, (dt - (lag - k * h)) / dt));
      const gx = from.x + (goal.x - from.x) * u;
      const gy = from.y + (goal.y - from.y) * u;
      const gz = from.z + (goal.z - from.z) * u;
      // Semi-implicit Euler with implicit damping: stable for any damping at this step.
      v.x = (v.x + stiffness * (gx - p.x)) / damping;
      v.y = (v.y + stiffness * (gy - p.y)) / damping;
      v.z = (v.z + stiffness * (gz - p.z)) / damping;
      vec3.scaleAndAdd(p, p, v, h);
    }
    lag = Math.max(0, lag - steps * h);
    this.#lag = lag;
    vec3.copy(from, goal);
  }

  /** Turns the node from its pose so that its tip points at the particle. */
  #apply(): void {
    const node = this.node;
    if (node.destroyed) return;
    node.localToWorld(goal, this.tip);
    if (!this.#settled) {
      this.#settle(goal);
      return;
    }
    vec3.scaleAndAdd(shown, this.#position, this.#velocity, this.#lag);
    node.localToWorld(center, node.pivot);
    vec3.sub(toGoal, goal, center);
    vec3.sub(toShown, shown, center);
    // The turn is found in the parent's space, where the node's rotation applies.
    const parent = node.parent;
    if (parent) {
      if (!mat3x4.invert(inverse, parent.worldMatrix)) return;
      mat3x4.transformDirection(toGoal, inverse, toGoal);
      mat3x4.transformDirection(toShown, inverse, toShown);
    }
    quat.rotationTo(turn, toGoal, toShown);
    const angle = quat.angleBetween(turn, IDENTITY);
    if (angle > this.#maxAngle) quat.slerp(turn, IDENTITY, turn, this.#maxAngle / angle);
    if (angle === 0) return;
    quat.multiply(turn, turn, node.rotation);
    node.rotation.copy(turn);
  }

  static {
    springInternals = {
      step: (spring, dt) => spring.#step(dt),
      apply: (spring) => spring.#apply(),
    };
  }
}

/** Simulates `spring` for `dt` seconds (see `Animator.update`). */
export function stepSpring(spring: Spring, dt: number): void {
  springInternals.step(spring, dt);
}

/** Turns the node of `spring` by its current state (see `Animator.evaluate`). */
export function applySpring(spring: Spring): void {
  springInternals.apply(spring);
}
