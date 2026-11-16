import {
  Animator,
  type Camera,
  CanvasRenderer,
  type Constraint,
  DragRotate,
  type DragRotateOptions,
  type Inputs,
  type Node,
  type PointerHandler,
  PointerInputs,
  type PointerInputsSpec,
  type Rig,
  Scene,
  SPRING_MAX_DT,
  type StateMachine,
  type Target,
  Ticker,
  type TickSubscription,
  WebGLRenderer,
} from '@mascotte/engine';
import { buildDocument, type MascotDocument, readDocument } from '@mascotte/format';
import { type IntersectionObserverFactory, pauseWhenOffscreen } from './page.ts';
import { bindPointer, type PointerElement } from './pointer.ts';

/** What the player needs from its canvas. */
export type PlayerCanvas = PointerElement &
  Pick<HTMLCanvasElement, 'width' | 'height' | 'clientWidth' | 'clientHeight' | 'getContext'>;

/** Which pointer inputs a mascot's machines read; see `PointerInputsSpec`. */
export type PointerSpec = Pick<PointerInputsSpec, 'target' | 'hover' | 'press' | 'drag' | 'click'>;

export interface PlayerOptions {
  /** `'auto'` (default) draws with WebGL2 and falls back to Canvas 2D where it is missing. */
  readonly renderer?: 'auto' | 'webgl' | 'canvas';
  /** The loop the player runs on; `Ticker.shared` by default. */
  readonly ticker?: Ticker;
  /** Inputs the pointer drives over the mascot (`{ hover: 'hover', click: 'poke' }`). */
  readonly pointer?: PointerSpec | null;
  /**
   * The name of an `aim` or `lookAt` constraint in the document that follows the pointer over
   * the canvas: it eases in while the pointer is there and out when it leaves.
   */
  readonly gaze?: string | null;
  /** Dragging turns the mascot's root (`DragRotate`); `null`, the default, does not. */
  readonly turn?: DragRotateOptions | null;
  /** Whether the animation runs from the start; true by default. */
  readonly autoplay?: boolean;
  /** Called with an error thrown in a frame; the loop stops. Defaults to `console.error`. */
  readonly onError?: (error: unknown) => void;
  /** Watches the canvas leaving the viewport; `IntersectionObserver` by default. */
  readonly createObserver?: IntersectionObserverFactory;
}

/** One document running in the player: what `load` swaps. */
interface Running {
  readonly document: MascotDocument;
  readonly root: Node;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly rig: Rig;
  readonly animator: Animator;
  readonly machines: readonly StateMachine[];
  readonly constraints: ReadonlyMap<string, Constraint>;
  readonly pointer: PointerInputs | null;
  readonly turn: DragRotate | null;
  readonly gaze: Gaze | null;
}

type Draw = (scene: Scene, camera: Camera, viewport: Viewport) => void;
interface Viewport {
  width: number;
  height: number;
  pixelRatio: number;
  background?: string;
}

/** Turns the gaze constraint's head towards the pointer, easing in and out. */
class Gaze {
  readonly #constraint: Constraint & { point: unknown; weight: number };
  readonly #head: Node;
  readonly #camera: Camera;
  readonly #frame: Viewport;
  #pointer: { x: number; y: number } | null = null;
  readonly #center = { x: 0, y: 0, z: 0 };
  readonly #view = { x: 0, y: 0, z: 0 };
  readonly #target = { x: 0, y: 0, z: 0 };
  readonly #looked = { x: 0, y: 0, z: 0 };
  #aimed = false;

  constructor(constraint: Constraint, head: Node, camera: Camera, frame: Viewport) {
    if (!('point' in constraint)) {
      throw new Error(`Player: the gaze constraint is a ${constraint.kind}, not an aim or lookAt.`);
    }
    this.#constraint = constraint as Constraint & { point: unknown; weight: number };
    this.#head = head;
    this.#camera = camera;
    this.#frame = frame;
    this.#constraint.weight = 0;
  }

  track(x: number, y: number): void {
    this.#pointer = { x: x - this.#frame.width / 2, y: y - this.#frame.height / 2 };
  }

  leave(): void {
    this.#pointer = null;
  }

  update(dt: number): void {
    // Ease towards the pointer, or back to the pose (time constant 1/6 s); a long step snaps.
    const ease = dt >= 0 && dt <= SPRING_MAX_DT ? 1 - Math.exp(-dt * 6) : 1;
    const gaze = this.#constraint;
    const weight = gaze.weight + ((this.#pointer ? 1 : 0) - gaze.weight) * ease;
    gaze.weight = Math.min(1, Math.max(0, weight));
    const pointer = this.#pointer;
    if (!pointer) return;
    // The point under the pointer, 120 units in front of the head.
    const head = this.#head;
    this.#camera.toView(this.#view, head.localToWorld(this.#center, head.pivot));
    const target = this.#camera.unproject(this.#target, pointer.x, pointer.y, this.#view.z + 120);
    if (!target) return;
    const k = this.#aimed ? ease : 1;
    const looked = this.#looked;
    looked.x += (target.x - looked.x) * k;
    looked.y += (target.y - looked.y) * k;
    looked.z += (target.z - looked.z) * k;
    gaze.point = looked;
    this.#aimed = true;
  }
}

function nodeOf(target: Target, scene: Scene, rig: Rig): Node | null {
  return typeof target === 'string' ? scene.getById(target) : rig.node(target.slot);
}

/**
 * Plays a mascot document on a canvas: builds it, runs its animation on a ticker and draws it,
 * fitting the document's frame (`view`) into the canvas's CSS size at the device pixel ratio.
 * The page talks to it through `inputs` (set and fire the machines' inputs) and options that
 * let the pointer drive inputs, a gaze and a drag turn. `load` swaps the document in place;
 * `destroy` frees the canvas.
 */
export class Player {
  readonly #canvas: PlayerCanvas;
  readonly #options: PlayerOptions;
  readonly #draw: Draw;
  readonly #invalidate: () => void;
  readonly #destroyRenderer: () => void;
  readonly #subscription: TickSubscription;
  readonly #unobserve: () => void;
  readonly #unbind: () => void;
  readonly #frame: Viewport = { width: 1, height: 1, pixelRatio: 1 };
  #running: Running;
  #playing: boolean;
  #destroyed = false;

  /** Reads and builds `document` (a JSON string or a parsed value); throws a `DocumentError`. */
  constructor(canvas: PlayerCanvas, document: unknown, options: PlayerOptions = {}) {
    this.#canvas = canvas;
    this.#options = options;
    this.#running = this.#start(readDocument(document));
    const renderer = this.#renderer(options.renderer ?? 'auto');
    this.#draw = renderer.draw;
    this.#invalidate = renderer.invalidate;
    this.#destroyRenderer = renderer.destroy;
    this.#playing = options.autoplay ?? true;
    this.#subscription = (options.ticker ?? Ticker.shared).add((dt) => this.#tick(dt));
    if (!this.#playing) this.#subscription.pause('stopped');
    this.#unobserve = pauseWhenOffscreen(
      this.#subscription,
      canvas as unknown as Element,
      options.createObserver,
    );
    this.#unbind = bindPointer(canvas, this.#frame, this.#pointerHandler());
    this.render();
  }

  /** The inputs of the document's machines: `inputs.set('happy', true)`, `inputs.fire('poke')`. */
  get inputs(): Inputs {
    return this.#running.animator.inputs;
  }

  /** The running document, as read (migrated and validated). */
  get document(): MascotDocument {
    return this.#running.document;
  }

  get animator(): Animator {
    return this.#running.animator;
  }

  get scene(): Scene {
    return this.#running.scene;
  }

  /** The document's state machines, in its order. */
  get machines(): readonly StateMachine[] {
    return this.#running.machines;
  }

  /** The document's named constraints. */
  get constraints(): ReadonlyMap<string, Constraint> {
    return this.#running.constraints;
  }

  get playing(): boolean {
    return this.#playing;
  }

  play(): void {
    this.#playing = true;
    this.#subscription.resume('stopped');
  }

  /** Stops time; the last frame stays on the canvas. */
  pause(): void {
    this.#playing = false;
    this.#subscription.pause('stopped');
  }

  /**
   * Swaps in another document without recreating the player: the canvas, renderer, loop and
   * pointer stay. A document that cannot be read or built throws a `DocumentError` and the
   * running one stays.
   */
  load(document: unknown): void {
    this.#check();
    const next = this.#start(readDocument(document));
    this.#running.pointer?.leave();
    this.#running = next;
    this.#invalidate();
    this.render();
  }

  /** Draws the current pose now, fitting the canvas first (the loop does it every frame). */
  render(): void {
    this.#check();
    this.#fit();
    const { scene, camera, document } = this.#running;
    const background = document.view.background;
    this.#draw(
      scene,
      camera,
      background === undefined ? this.#frame : { ...this.#frame, background },
    );
  }

  /** Stops the loop, unbinds the pointer and frees the renderer. A repeated call does nothing. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#subscription.remove();
    this.#unobserve();
    this.#unbind();
    this.#destroyRenderer();
  }

  #check(): void {
    if (this.#destroyed) throw new Error('Player: it has been destroyed.');
  }

  #start(document: MascotDocument): Running {
    const built = buildDocument(document);
    const scene = new Scene(built.root);
    const animator = new Animator(scene, { rig: built.rig });
    const { machines, constraints } = built.animate(animator);
    const { pointer: spec, gaze: gazeName, turn: turnOptions } = this.#options;
    const pointer = spec
      ? new PointerInputs(animator, { ...spec, camera: built.camera, viewport: this.#frame })
      : null;
    let gaze: Gaze | null = null;
    if (gazeName) {
      const constraint = constraints.get(gazeName);
      if (!constraint) throw new Error(`Player: the document has no constraint "${gazeName}".`);
      const head = nodeOf(constraint.target, scene, built.rig);
      if (!head) throw new Error(`Player: the gaze constraint "${gazeName}" has no node.`);
      gaze = new Gaze(constraint, head, built.camera, this.#frame);
    }
    const turn = turnOptions ? new DragRotate(built.root, turnOptions) : null;
    animator.evaluate();
    return {
      document,
      root: built.root,
      scene,
      camera: built.camera,
      rig: built.rig,
      animator,
      machines,
      constraints,
      pointer,
      turn,
      gaze,
    };
  }

  #renderer(kind: 'auto' | 'webgl' | 'canvas'): {
    draw: Draw;
    invalidate: () => void;
    destroy: () => void;
  } {
    if (kind !== 'canvas') {
      try {
        const gl = new WebGLRenderer(this.#canvas as HTMLCanvasElement);
        return {
          draw: (scene, camera, viewport) => {
            gl.render(scene, camera, viewport);
          },
          invalidate: () => gl.invalidate(),
          destroy: () => gl.destroy(),
        };
      } catch (error) {
        if (kind === 'webgl') throw error;
      }
    }
    const ctx = this.#canvas.getContext('2d');
    if (!ctx) throw new Error('Player: neither WebGL2 nor Canvas 2D is available on this canvas.');
    const canvas2d = new CanvasRenderer();
    return {
      draw: (scene, camera, viewport) => canvas2d.render(ctx, scene, camera, viewport),
      invalidate: () => {},
      destroy: () => {},
    };
  }

  /**
   * Fits the document's frame into the canvas's CSS size (all of it in view, centered) at the
   * device pixel ratio; a canvas with no layout size shows the frame at its own size.
   */
  #fit(): void {
    const { width, height } = this.#running.document.view;
    const cssWidth = this.#canvas.clientWidth || width;
    const cssHeight = this.#canvas.clientHeight || height;
    const scale = Math.min(cssWidth / width, cssHeight / height);
    const ratio = (globalThis.devicePixelRatio || 1) * scale;
    this.#frame.width = cssWidth / scale;
    this.#frame.height = cssHeight / scale;
    this.#frame.pixelRatio = ratio;
    const pixelWidth = Math.round(cssWidth * (globalThis.devicePixelRatio || 1));
    const pixelHeight = Math.round(cssHeight * (globalThis.devicePixelRatio || 1));
    // Setting the size clears the canvas, so only when it changes.
    if (this.#canvas.width !== pixelWidth) this.#canvas.width = pixelWidth;
    if (this.#canvas.height !== pixelHeight) this.#canvas.height = pixelHeight;
  }

  #tick(dt: number): void {
    try {
      const { pointer, gaze, turn, animator } = this.#running;
      // Hover is tested against the frame on screen, before the pose moves on.
      pointer?.update();
      gaze?.update(dt);
      turn?.update(dt);
      animator.update(dt);
      this.render();
    } catch (error) {
      this.#subscription.pause('error');
      (this.#options.onError ?? console.error)(error);
    }
  }

  /** Forwards the pointer to whatever the running document uses. */
  #pointerHandler(): PointerHandler {
    return {
      down: (x, y) => {
        const { pointer, gaze, turn } = this.#running;
        pointer?.down(x, y);
        gaze?.track(x, y);
        turn?.down(x, y);
      },
      move: (x, y) => {
        const { pointer, gaze, turn } = this.#running;
        pointer?.move(x, y);
        gaze?.track(x, y);
        turn?.move(x, y);
      },
      up: (x, y) => {
        const { pointer, gaze, turn } = this.#running;
        gaze?.track(x, y);
        turn?.up(x, y);
        if (!pointer) return;
        // A click while paused would switch states the paused machines cannot play.
        if (this.#playing) pointer.up(x, y);
        else {
          pointer.leave();
          pointer.move(x, y);
        }
      },
      leave: () => {
        const { pointer, gaze, turn } = this.#running;
        pointer?.leave();
        gaze?.leave();
        turn?.leave();
      },
    };
  }
}
