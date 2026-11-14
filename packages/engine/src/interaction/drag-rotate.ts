import { clamp, type Quat, quat } from '@mascotte/math';
import type { Node } from '../scene/node.ts';
import type { PointerHandler } from './pointer.ts';

export interface DragRotateOptions {
  /** Radians of turn per frame unit of drag; 0.01 by default. */
  speed?: number;
  /** The largest tilt up or down, in radians; π/2 by default. */
  maxPitch?: number;
  /**
   * After a drag the node turns back to its rest rotation with this time constant in seconds
   * (`update(dt)` does it); 0, the default, leaves it where the drag ended.
   */
  settle?: number;
}

const X_AXIS = { x: 1, y: 0, z: 0 } as const;
const Y_AXIS = { x: 0, y: 1, z: 0 } as const;
// Below this the settling turn is snapped to the rest rotation.
const SETTLED = 1e-4;

function check(name: string, value: number, min: number): number {
  if (!(Number.isFinite(value) && value >= min)) {
    throw new RangeError(`DragRotate: ${name} must be a finite number ≥ ${min}, got ${value}.`);
  }
  return value;
}

/**
 * Mouse rotation, like Zdog's `dragRotate`: dragging anywhere over the frame turns a node,
 * left and right about its parent's y axis (yaw), up and down about the parent's x axis (pitch,
 * within `maxPitch`), on top of the rotation the node had when this was made. The turn follows
 * the pointer: the side facing the viewer moves the way the pointer does. Use a node whose
 * rotation the animator does not animate (the mascot's root, or a node above it), otherwise the
 * pose overwrites the turn every frame.
 */
export class DragRotate implements PointerHandler {
  readonly node: Node;
  readonly #rest: Quat;
  readonly #speed: number;
  readonly #maxPitch: number;
  readonly #settle: number;
  #yaw = 0;
  #pitch = 0;
  #dragging = false;
  #startX = 0;
  #startY = 0;
  #startYaw = 0;
  #startPitch = 0;
  readonly #turn = quat.create();
  readonly #scratch = quat.create();

  constructor(node: Node, options: DragRotateOptions = {}) {
    this.#speed = check('speed', options.speed ?? 0.01, 0);
    this.#maxPitch = check('maxPitch', options.maxPitch ?? Math.PI / 2, 0);
    this.#settle = check('settle', options.settle ?? 0, 0);
    this.node = node;
    const { x, y, z, w } = node.rotation;
    this.#rest = quat.set(quat.create(), x, y, z, w);
  }

  /** The turn about the parent's y axis, in radians. */
  get yaw(): number {
    return this.#yaw;
  }

  /** The turn about the parent's x axis, in radians. */
  get pitch(): number {
    return this.#pitch;
  }

  get dragging(): boolean {
    return this.#dragging;
  }

  down(x: number, y: number): void {
    this.#dragging = true;
    this.#startX = x;
    this.#startY = y;
    this.#startYaw = this.#yaw;
    this.#startPitch = this.#pitch;
  }

  move(x: number, y: number): void {
    if (!this.#dragging) return;
    // y is down: dragging down tilts the front down, a negative turn about x.
    this.#turnTo(
      this.#startYaw + (x - this.#startX) * this.#speed,
      this.#startPitch - (y - this.#startY) * this.#speed,
    );
  }

  up(x: number, y: number): void {
    this.move(x, y);
    this.#dragging = false;
  }

  leave(): void {
    this.#dragging = false;
  }

  /** Turns back towards the rest rotation after a drag, if `settle` is set. */
  update(dt: number): void {
    if (this.#dragging || this.#settle === 0 || !(dt > 0)) return;
    const k = Math.exp(-dt / this.#settle);
    const yaw = Math.abs(this.#yaw * k) < SETTLED ? 0 : this.#yaw * k;
    const pitch = Math.abs(this.#pitch * k) < SETTLED ? 0 : this.#pitch * k;
    this.#turnTo(yaw, pitch);
  }

  /** Back to the rest rotation at once; ends a drag. */
  reset(): void {
    this.#dragging = false;
    this.#turnTo(0, 0);
  }

  #turnTo(yaw: number, pitch: number): void {
    this.#yaw = yaw;
    this.#pitch = clamp(pitch, -this.#maxPitch, this.#maxPitch);
    const turn = quat.setAxisAngle(this.#turn, X_AXIS, this.#pitch);
    quat.multiply(turn, turn, quat.setAxisAngle(this.#scratch, Y_AXIS, this.#yaw));
    const { x, y, z, w } = quat.multiply(turn, turn, this.#rest);
    this.node.rotation.set(x, y, z, w);
  }
}
