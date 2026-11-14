import type { Animator } from '../animation/animator.ts';
import { checkInput, type InputSpec } from '../animation/inputs.ts';
import { HitTester, type HitViewport } from '../render/hit-test.ts';
import { lookupTarget, resolveTarget, type Target, targetName } from '../rig/rig.ts';
import type { Camera } from '../scene/camera.ts';

/**
 * What a pointer does over the frame, in frame units from its top left corner (the units of
 * `HitTester.hitTest`). The page forwards its pointer events here (`bindPointer` in
 * `@mascotte/player` does it for a canvas); the engine itself knows nothing about the DOM.
 */
export interface PointerHandler {
  down(x: number, y: number): void;
  move(x: number, y: number): void;
  up(x: number, y: number): void;
  /** The pointer left the frame or was cancelled: a press ends without a click. */
  leave(): void;
}

/**
 * How a `PointerInputs` hit-tests and which inputs it drives: each input is optional (a missing
 * one and `null` mean none), but at least one is named.
 */
export interface PointerInputsSpec {
  /** The camera the frame is shot with. */
  readonly camera: Camera;
  /** The frame size, the same as for rendering. */
  readonly viewport: HitViewport;
  /**
   * The node (by id or rig slot) whose subtree counts as hit; any shape by default. It must
   * resolve when the `PointerInputs` is made; if it stops resolving later, nothing is over it.
   */
  readonly target?: Target | null;
  /** A `bool` input: the pointer is over the target. */
  readonly hover?: string | null;
  /** A `bool` input: a press that started on the target is held. */
  readonly press?: string | null;
  /** A `bool` input: that press has moved more than `CLICK_DISTANCE`. */
  readonly drag?: string | null;
  /** A `trigger`: that press was released on the target without dragging. */
  readonly click?: string | null;
}

/**
 * How far (in frame units) a press may move and still end in a click. A canvas drawn smaller
 * than its frame makes it shorter on screen.
 */
export const CLICK_DISTANCE = 6;

/**
 * Turns pointer events into state machine inputs by hit-testing the frame: hover, press, drag
 * and click on a target. It declares its inputs on `animator.inputs` (a machine reading them
 * declares them with the same types). Hover and press are separate: a held press stays held
 * when the pointer moves off the target. A press and its release are tested at once; hover is
 * tested in `update()`, which the page calls once per frame before `animator.update`, so a
 * shape that moves away from a still pointer stops being hovered.
 */
export class PointerInputs implements PointerHandler {
  readonly #animator: Animator;
  readonly #camera: Camera;
  readonly #viewport: HitViewport;
  readonly #target: Target | null;
  readonly #hover: string | null;
  readonly #press: string | null;
  readonly #drag: string | null;
  readonly #click: string | null;
  readonly #tester: HitTester;
  #x = 0;
  #y = 0;
  #inside = false;
  #hovering = false;
  #pressed = false;
  #dragging = false;
  #startX = 0;
  #startY = 0;

  constructor(animator: Animator, spec: PointerInputsSpec, tester = new HitTester()) {
    const hover = spec.hover ?? null;
    const press = spec.press ?? null;
    const drag = spec.drag ?? null;
    const click = spec.click ?? null;
    const inputs: InputSpec[] = [];
    for (const name of [hover, press, drag]) {
      if (name !== null) inputs.push({ name, type: 'bool' });
    }
    if (click !== null) inputs.push({ name: click, type: 'trigger' });
    if (inputs.length === 0) {
      throw new Error('PointerInputs: name at least one of hover, press, drag and click.');
    }
    if (new Set(inputs.map((input) => input.name)).size < inputs.length) {
      throw new Error('PointerInputs: hover, press, drag and click need different inputs.');
    }
    // Check them all first, so a bad one declares none.
    for (const input of inputs) checkInput(animator.inputs, input);
    const target = spec.target ?? null;
    if (target !== null) {
      const found = lookupTarget(target, animator);
      if (typeof found === 'string') {
        throw new Error(`PointerInputs: target ${targetName(target)}: ${found}`);
      }
    }
    for (const input of inputs) animator.inputs.define(input);
    this.#animator = animator;
    this.#camera = spec.camera;
    this.#viewport = spec.viewport;
    this.#target = target;
    this.#hover = hover;
    this.#press = press;
    this.#drag = drag;
    this.#click = click;
    this.#tester = tester;
  }

  /** The pointer is over the target (as of the last `update`, `down` or `up`). */
  get hovering(): boolean {
    return this.#hovering;
  }

  /** A press that started on the target is held. */
  get pressed(): boolean {
    return this.#pressed;
  }

  /** That press has moved more than `CLICK_DISTANCE`. */
  get dragging(): boolean {
    return this.#dragging;
  }

  down(x: number, y: number): void {
    this.move(x, y);
    this.#setHover(this.#over(x, y));
    if (!this.#hovering) return;
    this.#startX = x;
    this.#startY = y;
    this.#setPress(true, false);
  }

  move(x: number, y: number): void {
    this.#x = x;
    this.#y = y;
    this.#inside = true;
    if (this.#pressed && !this.#dragging) {
      if (Math.hypot(x - this.#startX, y - this.#startY) > CLICK_DISTANCE) {
        this.#setPress(true, true);
      }
    }
  }

  up(x: number, y: number): void {
    this.move(x, y);
    this.#setHover(this.#over(x, y));
    if (!this.#pressed) return;
    const click = !this.#dragging && this.#hovering;
    this.#setPress(false, false);
    if (click && this.#click !== null) this.#animator.inputs.fire(this.#click);
  }

  leave(): void {
    this.#inside = false;
    this.#setHover(false);
    this.#setPress(false, false);
  }

  /** Hit-tests the last pointer point against the current pose; call once per frame. */
  update(): void {
    this.#setHover(this.#inside && this.#over(this.#x, this.#y));
  }

  #over(x: number, y: number): boolean {
    const scene = this.#animator.scene;
    const hit = this.#tester.hitTest(scene, this.#camera, this.#viewport, x, y);
    if (!hit) return false;
    if (this.#target === null) return true;
    const node = resolveTarget(this.#target, this.#animator);
    return node !== null && (node === hit.drawable || node.isAncestorOf(hit.drawable));
  }

  #setHover(value: boolean): void {
    if (value === this.#hovering) return;
    this.#hovering = value;
    if (this.#hover !== null) this.#animator.inputs.set(this.#hover, value);
  }

  #setPress(pressed: boolean, dragging: boolean): void {
    if (pressed !== this.#pressed && this.#press !== null) {
      this.#animator.inputs.set(this.#press, pressed);
    }
    if (dragging !== this.#dragging && this.#drag !== null) {
      this.#animator.inputs.set(this.#drag, dragging);
    }
    this.#pressed = pressed;
    this.#dragging = dragging;
  }
}
