import {
  type AimConstraint,
  Animator,
  type Camera,
  CanvasRenderer,
  type Constraint,
  DragRotate,
  type DragRotateOptions,
  type Inputs,
  type LookAtConstraint,
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

/**
 * Which of the mascot's inputs the pointer drives (each must be one its machines read), and
 * optionally the node (`target`) that counts as the mascot; see `PointerInputsSpec`.
 */
export type PointerSpec = Pick<PointerInputsSpec, 'target' | 'hover' | 'press' | 'drag' | 'click'>;

export interface PlayerOptions {
  /**
   * `'auto'` (default) draws with WebGL2 and falls back to Canvas 2D where WebGL2 cannot start;
   * `renderer` on the player tells which one it took.
   */
  readonly renderer?: 'auto' | 'webgl' | 'canvas';
  /** The loop the player runs on; `Ticker.shared` by default. */
  readonly ticker?: Ticker;
  /** Inputs the pointer drives over the mascot (`{ hover: 'hover', click: 'poke' }`). */
  readonly pointer?: PointerSpec | null;
  /**
   * The name of an `aim` or `lookAt` constraint in the document, aimed at a point (not at a
   * node), that follows the pointer over the canvas: its weight eases to 1 while the pointer
   * is there and to 0 when it leaves.
   */
  readonly gaze?: string | null;
  /**
   * A drag anywhere on the canvas turns the mascot's root (`DragRotate`): the node bound to the
   * rig's `root` slot, or the tree's root without one, so a shadow beside the mascot stays on the
   * ground; `null`, the default, does not. That node's rotation must not be animated (library
   * motions move the root only): the animator would write its pose over the drag every frame.
   * A `pointer.drag` input is driven by the same drags.
   */
  readonly turn?: DragRotateOptions | null;
  /**
   * Values for the document's shape parameters (`{ earLength: 20 }`): one document, a family of
   * mascots. Unset, the document's defaults are used. `load` keeps them unless it is given its
   * own; a name the new document does not declare is a `DocumentError`.
   */
  readonly params?: Readonly<Record<string, number>>;
  /**
   * The palette to start with (`'dark'`, a brand); the document's first by default. `setPalette`
   * switches it on the fly, and `load` keeps it unless it is given its own.
   */
  readonly palette?: string;
  /** Whether the animation runs from the start; true by default. */
  readonly autoplay?: boolean;
  /**
   * Called with an error thrown in a frame or a pointer event; the player pauses (`play()`
   * starts it again). Defaults to `console.error`.
   */
  readonly onError?: (error: unknown) => void;
  /** Watches the canvas leaving the viewport; `IntersectionObserver` by default. */
  readonly createObserver?: IntersectionObserverFactory;
}

/** One document running in the player: what `load` swaps. */
interface Running {
  readonly document: MascotDocument;
  readonly scene: Scene;
  readonly camera: Camera;
  readonly animator: Animator;
  readonly machines: readonly StateMachine[];
  readonly constraints: ReadonlyMap<string, Constraint>;
  readonly pointer: PointerInputs | null;
  readonly turn: DragRotate | null;
  readonly gaze: Gaze | null;
  /** Recolors the running mascot with a palette. */
  readonly palette: (name: string) => void;
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
  readonly #constraint: AimConstraint | LookAtConstraint;
  readonly #head: Node;
  readonly #camera: Camera;
  readonly #frame: Viewport;
  #pointer: { x: number; y: number } | null = null;
  readonly #center = { x: 0, y: 0, z: 0 };
  readonly #view = { x: 0, y: 0, z: 0 };
  readonly #target = { x: 0, y: 0, z: 0 };
  readonly #looked = { x: 0, y: 0, z: 0 };
  #aimed = false;

  constructor(
    constraint: AimConstraint | LookAtConstraint,
    head: Node,
    camera: Camera,
    frame: Viewport,
  ) {
    this.#constraint = constraint;
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
    const pointer = this.#pointer;
    const weight = gaze.weight + ((pointer ? 1 : 0) - gaze.weight) * ease;
    gaze.weight = Math.min(1, Math.max(0, weight));
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
 * `destroy` stops it and frees its renderer (the canvas stays the caller's). `inputs`,
 * `machines`, `constraints`, `animator` and `scene` belong to the running document: read them
 * again after `load`.
 */
export class Player {
  readonly #canvas: PlayerCanvas;
  readonly #options: PlayerOptions;
  #params: Readonly<Record<string, number>>;
  #palette: string | undefined;
  readonly #draw: Draw;
  readonly #invalidate: () => void;
  readonly #subscription: TickSubscription;
  /** What `destroy` undoes, in the order it was set up. */
  readonly #cleanups: (() => void)[] = [];
  readonly renderer: 'webgl' | 'canvas';
  readonly #frame: Viewport = { width: 1, height: 1, pixelRatio: 1 };
  #running: Running;
  #playing: boolean;
  #destroyed = false;

  /**
   * Reads and builds `document` (a JSON string or a parsed value) and draws its first frame.
   * Throws a `DocumentError` for a bad document, and an `Error` for options the document or
   * the canvas cannot satisfy; nothing is left bound then.
   */
  constructor(canvas: PlayerCanvas, document: unknown, options: PlayerOptions = {}) {
    this.#canvas = canvas;
    this.#options = options;
    this.#params = options.params ?? {};
    this.#palette = options.palette;
    this.#running = this.#start(readDocument(document), this.#params, this.#palette);
    const renderer = this.#renderer(options.renderer ?? 'auto');
    this.renderer = renderer.kind;
    this.#draw = renderer.draw;
    this.#invalidate = renderer.invalidate;
    this.#cleanups.push(renderer.destroy);
    this.#playing = options.autoplay ?? true;
    this.#subscription = (options.ticker ?? Ticker.shared).add((dt) => this.#tick(dt));
    this.#cleanups.push(() => this.#subscription.remove());
    try {
      if (!this.#playing) this.#subscription.pause('stopped');
      const element = canvas as unknown as Element;
      this.#cleanups.push(pauseWhenOffscreen(this.#subscription, element, options.createObserver));
      this.#cleanups.push(bindPointer(canvas, this.#frame, this.#pointerHandler()));
      this.render();
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /**
   * The inputs of the running document's machines: `inputs.set('happy', true)`,
   * `inputs.fire('poke')`. A new object after `load`.
   */
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

  /** Whether time runs: false after `pause()`, or after an error paused the player. */
  get playing(): boolean {
    return this.#playing;
  }

  play(): void {
    this.#check();
    this.#playing = true;
    this.#subscription.resume('stopped');
  }

  /**
   * Stops time; the last frame stays on the canvas. The pointer still turns, aims and hovers,
   * shown on the next frame, but a click does not fire.
   */
  pause(): void {
    this.#check();
    this.#playing = false;
    this.#subscription.pause('stopped');
  }

  /**
   * Swaps in another document without recreating the player: the canvas, renderer, loop and
   * pointer stay, and so does whether it plays. `params` replace the shape parameters from now
   * on (`{}` for the new document's defaults). A document that cannot be read or built, or does
   * not fit the options, throws as in the constructor and the running one (and its
   * parameters) stays. `palette` replaces the palette (`undefined` for the new document's first);
   * left out, the current one stays where the new document has it, and the first is used where
   * it does not.
   */
  load(
    document: unknown,
    options: {
      readonly params?: Readonly<Record<string, number>>;
      readonly palette?: string | undefined;
    } = {},
  ): void {
    this.#check();
    const read = readDocument(document);
    const params = options.params ?? this.#params;
    // A palette given is required; one kept from before falls back to the base where missing.
    let palette = this.#palette;
    if ('palette' in options) palette = options.palette;
    else if (palette !== undefined && !Object.hasOwn(read.palettes ?? {}, palette)) {
      palette = undefined;
    }
    const next = this.#start(read, params, palette);
    this.#params = params;
    this.#palette = palette;
    this.#running.pointer?.leave();
    this.#running = next;
    this.#invalidate();
    this.render();
  }

  /**
   * Draws the current pose now, fitting the canvas first. The loop does it every frame it
   * plays; a paused player picks up a new canvas size here.
   */
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

  /**
   * Removes its loop subscription, unbinds the pointer and frees the renderer; the canvas stays
   * the caller's. A repeated call does nothing; any other call throws afterwards.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const cleanup of this.#cleanups.splice(0).reverse()) cleanup();
  }

  #check(): void {
    if (this.#destroyed) throw new Error('Player: it has been destroyed.');
  }

  #start(
    document: MascotDocument,
    params: Readonly<Record<string, number>>,
    palette: string | undefined,
  ): Running {
    const built = buildDocument(document, palette === undefined ? { params } : { params, palette });
    const scene = new Scene(built.root);
    const animator = new Animator(scene, { rig: built.rig });
    const { machines, constraints } = built.animate(animator);
    const { pointer: spec, gaze: gazeName, turn: turnOptions } = this.#options;
    let pointer: PointerInputs | null = null;
    if (spec) {
      // `PointerInputs` declares a name nothing reads without complaint: check it here.
      for (const name of [spec.hover, spec.press, spec.drag, spec.click]) {
        if (name && !animator.inputs.has(name)) {
          throw new Error(`Player: the document has no input "${name}" for the pointer.`);
        }
      }
      pointer = new PointerInputs(animator, {
        ...spec,
        camera: built.camera,
        viewport: this.#frame,
      });
    }
    let gaze: Gaze | null = null;
    if (gazeName) {
      const constraint = constraints.get(gazeName);
      if (!constraint) throw new Error(`Player: the document has no constraint "${gazeName}".`);
      if ((constraint.kind !== 'aim' && constraint.kind !== 'lookAt') || constraint.at !== null) {
        const found = 'at' in constraint && constraint.at !== null ? 'follows a node' : 'is not';
        throw new Error(
          `Player: the gaze "${gazeName}" must be an aim or lookAt aimed at a point; it ${found} (kind ${constraint.kind}).`,
        );
      }
      const head = nodeOf(constraint.target, scene, built.rig);
      if (!head) throw new Error(`Player: the gaze constraint "${gazeName}" has no node.`);
      gaze = new Gaze(constraint, head, built.camera, this.#frame);
    }
    const turned = built.rig.node('root') ?? built.root;
    const turn = turnOptions ? new DragRotate(turned, turnOptions) : null;
    animator.evaluate();
    return {
      document,
      scene,
      camera: built.camera,
      animator,
      machines,
      constraints,
      pointer,
      turn,
      gaze,
      palette: (name) => built.palette(name, animator),
    };
  }

  /** The running palette: the one set, or the document's first; `undefined` without palettes. */
  get palette(): string | undefined {
    return this.#palette ?? this.palettes[0];
  }

  /** The palettes of the running document, the first being its base. */
  get palettes(): readonly string[] {
    return Object.keys(this.#running.document.palettes ?? {});
  }

  /**
   * Recolors the mascot with another palette of its document, on the fly: nothing is rebuilt and
   * the animation goes on (colors its clips animate rest at the new color). Throws a
   * `DocumentError` for a palette the document does not have, and changes nothing then.
   */
  setPalette(name: string): void {
    this.#check();
    this.#running.palette(name);
    this.#palette = name;
    this.render();
  }

  #renderer(kind: 'auto' | 'webgl' | 'canvas'): {
    kind: 'webgl' | 'canvas';
    draw: Draw;
    invalidate: () => void;
    destroy: () => void;
  } {
    let failed: unknown;
    if (kind !== 'canvas') {
      try {
        const gl = new WebGLRenderer(this.#canvas as HTMLCanvasElement);
        return {
          kind: 'webgl',
          draw: (scene, camera, viewport) => {
            gl.render(scene, camera, viewport);
          },
          invalidate: () => gl.invalidate(),
          destroy: () => gl.destroy(),
        };
      } catch (error) {
        if (kind === 'webgl') throw error;
        failed = error;
      }
    }
    // A canvas WebGL2 started on but failed has no 2D context; then the WebGL error explains.
    const ctx = this.#canvas.getContext('2d');
    if (!ctx) {
      const message = 'Player: neither WebGL2 nor Canvas 2D is available on this canvas.';
      throw new Error(message, failed === undefined ? undefined : { cause: failed });
    }
    const canvas2d = new CanvasRenderer();
    return {
      kind: 'canvas',
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
    const dpr = globalThis.devicePixelRatio || 1;
    this.#frame.width = cssWidth / scale;
    this.#frame.height = cssHeight / scale;
    this.#frame.pixelRatio = dpr * scale;
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);
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
      this.#fail(error);
    }
  }

  /** Pauses the player and reports the error. */
  #fail(error: unknown): void {
    this.#playing = false;
    this.#subscription.pause('stopped');
    (this.#options.onError ?? console.error)(error);
  }

  /** Runs a pointer step for the running document; an error pauses and is reported. */
  #guard(step: (running: Running) => void): void {
    try {
      step(this.#running);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Forwards the pointer to the running document's pointer inputs, gaze and turn. */
  #pointerHandler(): PointerHandler {
    return {
      down: (x, y) =>
        this.#guard(({ pointer, gaze, turn }) => {
          pointer?.down(x, y);
          gaze?.track(x, y);
          turn?.down(x, y);
        }),
      move: (x, y) =>
        this.#guard(({ pointer, gaze, turn }) => {
          pointer?.move(x, y);
          gaze?.track(x, y);
          turn?.move(x, y);
        }),
      up: (x, y) =>
        this.#guard(({ pointer, gaze, turn }) => {
          gaze?.track(x, y);
          turn?.up(x, y);
          if (!pointer) return;
          // A click while paused would switch states the paused machines cannot play.
          if (this.#playing) pointer.up(x, y);
          else {
            pointer.leave();
            pointer.move(x, y);
          }
        }),
      leave: () =>
        this.#guard(({ pointer, gaze, turn }) => {
          pointer?.leave();
          gaze?.leave();
          turn?.leave();
        }),
    };
  }
}
