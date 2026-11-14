import {
  Animator,
  bindClip,
  Camera,
  CanvasRenderer,
  DragRotate,
  HitTester,
  type PointerHandler,
  PointerInputs,
  Scene,
  SPRING_MAX_DT,
  Ticker,
  WebGLRenderer,
} from '@mascotte/engine';
import { bindPointer, pauseWhenOffscreen } from '@mascotte/player';
import {
  animatedMascot,
  buildBenchmark,
  type EngineScene,
  engineScenes,
  lookAroundClip,
  type ReferenceScene,
  referenceScenes,
} from '@mascotte/reference';

/** A playground example: mounts into a container and returns a cleanup function. */
export interface Example {
  id: string;
  title: string;
  group: string;
  mount(container: HTMLElement, controls: ExampleControls): () => void;
}

export interface ExampleControls {
  /** Whether animation is on. The example reads the value every frame. */
  readonly animate: boolean;
  /** Reports a finished frame for the fps counter. */
  frame(): void;
  /** Reports an error in the frame loop. The example stops after it. */
  error(error: unknown): void;
}

/** The scene is shown at twice its size. */
const displayScale = 2;

/**
 * Calls `callback` on every devicePixelRatio change: moving the window to another monitor
 * or changing the page zoom. Returns an unsubscribe function.
 */
function watchPixelRatio(callback: () => void): () => void {
  let query: MediaQueryList | undefined;
  const subscribe = () => {
    query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener('change', onChange, { once: true });
  };
  const onChange = () => {
    callback();
    subscribe();
  };
  subscribe();
  return () => query?.removeEventListener('change', onChange);
}

/**
 * The example's frame loop on the shared page ticker: time runs while animation is on, and an
 * offscreen canvas gets no frames. The example stops after an error.
 */
function runLoop(
  canvas: HTMLCanvasElement,
  controls: ExampleControls,
  frame: (time: number) => void,
): () => void {
  let time = 0;
  const subscription = Ticker.shared.add((dt) => {
    try {
      if (controls.animate) time += dt;
      frame(time);
      controls.frame();
    } catch (error) {
      controls.error(error);
      subscription.remove();
    }
  });
  const unobserve = pauseWhenOffscreen(subscription, canvas);
  return () => {
    unobserve();
    subscription.remove();
  };
}

type Draw = (ctx: CanvasRenderingContext2D, pixelRatio: number, time: number) => void;

/** A canvas with a frame loop that respects devicePixelRatio. */
function mountCanvas(
  container: HTMLElement,
  controls: ExampleControls,
  scene: Pick<ReferenceScene, 'width' | 'height'>,
  draw: Draw,
  scale = displayScale,
): () => void {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available in this browser.');
  canvas.style.width = `${scene.width * scale}px`;
  canvas.style.maxWidth = '100%';

  let pixelRatio = 1;
  const resize = () => {
    pixelRatio = (window.devicePixelRatio || 1) * scale;
    canvas.width = scene.width * pixelRatio;
    canvas.height = scene.height * pixelRatio;
  };
  resize();
  const unwatch = watchPixelRatio(resize);
  container.append(canvas);

  const stop = runLoop(canvas, controls, (time) => draw(ctx, pixelRatio, time));
  return () => {
    stop();
    unwatch();
    canvas.remove();
  };
}

type DrawGL = (renderer: WebGLRenderer, pixelRatio: number, time: number) => void;

/** The node type and its id, if the id was set rather than generated. */
function nodeLabel(node: { id: string; typeName: string }): string {
  return node.id.startsWith('~') ? node.typeName : `${node.typeName} "${node.id}"`;
}

/** What to show under the canvas on hover: the example's scene and camera. */
interface HitSource {
  scene: Scene;
  camera: Camera;
}

/** A caption under the canvas with the node under the pointer. */
interface HitLabel {
  /** Recompute the hit: called after every frame, since shapes move. */
  update(): void;
  /** Remove the caption and the handlers. */
  dispose(): void;
}

/**
 * A caption under the canvas with the node under the pointer: a hit test against the current
 * frame. Pointer movement only stores the point, and the hit is computed once after each
 * frame. This way a shape that moved away from a still pointer is not reported under it, and
 * the scene is not traversed twice per frame.
 */
function showHits(
  container: HTMLElement,
  canvas: HTMLCanvasElement,
  size: { width: number; height: number },
  pick: HitSource,
): HitLabel {
  const label = document.createElement('p');
  label.className = 'hit';
  const idle = 'Hover over a shape.';
  label.textContent = idle;
  container.append(label);
  const tester = new HitTester();
  // The pointer in frame pixels, or null when it is outside the canvas.
  let pointer: { x: number; y: number } | null = null;
  const update = () => {
    if (!pointer) return;
    const hit = tester.hitTest(pick.scene, pick.camera, size, pointer.x, pointer.y);
    canvas.style.cursor = hit ? 'pointer' : '';
    const text = hit
      ? hit.node === hit.drawable
        ? `Under the pointer: ${nodeLabel(hit.node)}`
        : `Under the pointer: ${nodeLabel(hit.drawable)}, part of ${nodeLabel(hit.node)}`
      : 'Nothing under the pointer.';
    if (label.textContent !== text) label.textContent = text;
  };
  const move = (event: PointerEvent) => {
    // The canvas may be shrunk in width: convert to frame pixels.
    const scale = size.width / canvas.clientWidth;
    pointer = { x: event.offsetX * scale, y: event.offsetY * scale };
  };
  const leave = () => {
    pointer = null;
    canvas.style.cursor = '';
    label.textContent = idle;
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerleave', leave);
  return {
    update,
    dispose() {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerleave', leave);
      label.remove();
    },
  };
}

/** A WebGL2 canvas with a frame loop. */
function mountGL(
  container: HTMLElement,
  controls: ExampleControls,
  scene: Pick<ReferenceScene, 'width' | 'height'>,
  draw: DrawGL,
  pick?: HitSource,
  scale = displayScale,
): () => void {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${scene.width * scale}px`;
  canvas.style.maxWidth = '100%';
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer(canvas);
  } catch (error) {
    controls.error(error);
    return () => {};
  }
  let pixelRatio = 1;
  const resize = () => {
    pixelRatio = (window.devicePixelRatio || 1) * scale;
    canvas.width = scene.width * pixelRatio;
    canvas.height = scene.height * pixelRatio;
  };
  resize();
  const unwatch = watchPixelRatio(resize);
  container.append(canvas);
  const hits = pick ? showHits(container, canvas, scene, pick) : null;
  const stop = runLoop(canvas, controls, (time) => {
    draw(renderer, pixelRatio, time);
    hits?.update();
  });
  return () => {
    stop();
    unwatch();
    hits?.dispose();
    renderer.destroy();
    canvas.remove();
  };
}

function fromReferenceSceneGL(scene: ReferenceScene): Example {
  return {
    id: `webgl/${scene.id}`,
    title: scene.title,
    group: 'WebGL2',
    mount(container, controls) {
      const root = scene.engine.build();
      const world = new Scene(root);
      const camera = new Camera({ zoom: scene.zoom });
      return mountGL(
        container,
        controls,
        scene,
        (renderer, pixelRatio, time) => {
          scene.engine.pose(root, time);
          renderer.render(world, camera, {
            width: scene.width,
            height: scene.height,
            pixelRatio,
            background: scene.background,
          });
        },
        { scene: world, camera },
      );
    },
  };
}

function fromEngineOnlySceneGL(scene: EngineScene): Example {
  return {
    id: `webgl/${scene.id}`,
    title: scene.title,
    group: 'WebGL2',
    mount(container, controls) {
      const { root, camera } = scene.build();
      const world = new Scene(root);
      return mountGL(
        container,
        controls,
        scene,
        (renderer, pixelRatio, time) => {
          scene.pose(root, camera, time);
          renderer.render(world, camera, {
            width: scene.width,
            height: scene.height,
            pixelRatio,
            background: scene.background,
          });
        },
        { scene: world, camera },
      );
    },
  };
}

function fromEngineScene(scene: ReferenceScene): Example {
  return {
    id: `engine/${scene.id}`,
    title: scene.title,
    group: 'Canvas 2D',
    mount(container, controls) {
      const root = scene.engine.build();
      const world = new Scene(root);
      const camera = new Camera({ zoom: scene.zoom });
      const renderer = new CanvasRenderer();
      return mountCanvas(container, controls, scene, (ctx, pixelRatio, time) => {
        scene.engine.pose(root, time);
        renderer.render(ctx, world, camera, {
          width: scene.width,
          height: scene.height,
          pixelRatio,
          background: scene.background,
        });
      });
    },
  };
}

function fromEngineOnlyScene(scene: EngineScene): Example {
  return {
    id: `engine/${scene.id}`,
    title: scene.title,
    group: 'Canvas 2D',
    mount(container, controls) {
      const { root, camera } = scene.build();
      const world = new Scene(root);
      const renderer = new CanvasRenderer();
      return mountCanvas(container, controls, scene, (ctx, pixelRatio, time) => {
        scene.pose(root, camera, time);
        renderer.render(ctx, world, camera, {
          width: scene.width,
          height: scene.height,
          pixelRatio,
          background: scene.background,
        });
      });
    },
  };
}

/**
 * The line under the benchmark canvas: the shape count and the average CPU frame time
 * (pose, sort, build and draw commands); for WebGL2 without GPU work, for Canvas 2D
 * including rasterization.
 */
function frameStats(container: HTMLElement, drawables: number) {
  const label = document.createElement('p');
  label.className = 'hit';
  container.append(label);
  let total = 0;
  let frames = 0;
  let shown = performance.now();
  const show = (text: string) => {
    label.textContent = `${drawables} shapes · ${text}`;
  };
  show('no frame drawn yet');
  return {
    measure(ms: number) {
      total += ms;
      frames++;
      const now = performance.now();
      if (now - shown < 500) return;
      const average = total / frames;
      show(`frame ${average.toFixed(1)} ms CPU (up to ${Math.floor(1000 / average)} fps)`);
      total = 0;
      frames = 0;
      shown = now;
    },
    dispose() {
      label.remove();
    },
  };
}

const BENCHMARK_TITLE = 'Benchmark: 20 mascots';

function benchmarkGL(): Example {
  return {
    id: 'webgl/benchmark',
    title: BENCHMARK_TITLE,
    group: 'WebGL2',
    mount(container, controls) {
      const bench = buildBenchmark();
      const world = new Scene(bench.root);
      const unmount = mountGL(
        container,
        controls,
        bench,
        (renderer, pixelRatio, time) => {
          const start = performance.now();
          bench.pose(time);
          const drawn = renderer.render(world, bench.camera, {
            width: bench.width,
            height: bench.height,
            pixelRatio,
            background: bench.background,
          });
          // At rest no frame is drawn, so there is nothing to measure.
          if (drawn) stats.measure(performance.now() - start);
        },
        { scene: world, camera: bench.camera },
        1,
      );
      const stats = frameStats(container, bench.drawables);
      return () => {
        unmount();
        stats.dispose();
      };
    },
  };
}

function benchmarkCanvas(): Example {
  return {
    id: 'engine/benchmark',
    title: BENCHMARK_TITLE,
    group: 'Canvas 2D',
    mount(container, controls) {
      const bench = buildBenchmark();
      const world = new Scene(bench.root);
      const renderer = new CanvasRenderer();
      const unmount = mountCanvas(
        container,
        controls,
        bench,
        (ctx, pixelRatio, time) => {
          const start = performance.now();
          bench.pose(time);
          renderer.render(ctx, world, bench.camera, {
            width: bench.width,
            height: bench.height,
            pixelRatio,
            background: bench.background,
          });
          stats.measure(performance.now() - start);
        },
        1,
      );
      const stats = frameStats(container, bench.drawables);
      return () => {
        unmount();
        stats.dispose();
      };
    },
  };
}

/** The 3D mascot played by a clip instead of its scripted pose. */
function clipExampleGL(): Example {
  return {
    id: 'webgl/clip',
    title: 'Clip: mascot looks around',
    group: 'WebGL2',
    mount(container, controls) {
      const scene = engineScenes.find((item) => item.id === 'engine-mascot-3d');
      if (!scene) throw new Error('No engine-mascot-3d scene.');
      const { root, camera } = scene.build();
      const world = new Scene(root);
      const clip = bindClip(lookAroundClip, world);
      return mountGL(
        container,
        controls,
        scene,
        (renderer, pixelRatio, time) => {
          clip.apply(time);
          renderer.render(world, camera, {
            width: scene.width,
            height: scene.height,
            pixelRatio,
            background: scene.background,
          });
        },
        { scene: world, camera },
      );
    },
  };
}

/**
 * The animated mascot on animation layers; its head follows the pointer over the canvas (the
 * gaze eases in and out; outside the canvas it lets go, unless a press holds the pointer), it
 * smiles wider while the pointer is over the mascot (the `mood` input eases towards the hover
 * of `PointerInputs`), a click on the mascot pokes it (the `poke` trigger: it hops and gasps;
 * not while the animation is paused, when the machines could switch states but not play them)
 * and a drag turns it (`DragRotate` on its root, which turns back after the drag, once the
 * animation runs). Every frame advances the layers, the machines,
 * the gaze, the turn and the springs by the step of the example's time. The first frame, or a
 * step back or longer than `SPRING_MAX_DT`, seeks instead: the machines start again from their
 * initial states, the turn and the springs rest; while the animation is paused the step is 0
 * and the springs hold still.
 */
function animatedMascotExample(backend: 'gl' | 'canvas'): Example {
  const scene = animatedMascot;
  return {
    id: `${backend === 'gl' ? 'webgl' : 'engine'}/${scene.id}`,
    title: scene.title,
    group: backend === 'gl' ? 'WebGL2' : 'Canvas 2D',
    mount(container, controls) {
      const { root, camera, rig } = scene.build();
      const world = new Scene(root);
      const animator = new Animator(world, { rig });
      const { gaze } = scene.animate(animator);
      const head = rig.node('head');
      const body = rig.node('root');
      if (!head || !body) throw new Error('The animated mascot has no head or root slot.');
      const frame = { width: scene.width, height: scene.height };
      const poke = new PointerInputs(animator, { camera, viewport: frame, click: 'poke' });
      const turn = new DragRotate(body, { settle: 0.5 });
      let mood = 0;
      // The pointer over the canvas in frame units from the center, or null elsewhere.
      let pointer: { x: number; y: number } | null = null;
      const center = { x: 0, y: 0, z: 0 };
      const view = { x: 0, y: 0, z: 0 };
      const target = { x: 0, y: 0, z: 0 };
      const looked = { x: 0, y: 0, z: 0 };
      const follow = (dt: number) => {
        // Ease towards the pointer, or back to the pose (time constant 1/6 s); a seek snaps.
        const ease = dt >= 0 && dt <= SPRING_MAX_DT ? 1 - Math.exp(-dt * 6) : 1;
        const weight = gaze.weight + ((pointer ? 1 : 0) - gaze.weight) * ease;
        gaze.weight = Math.min(1, Math.max(0, weight));
        mood = Math.min(1, Math.max(0, mood + ((poke.hovering ? 1 : 0) - mood) * ease));
        animator.inputs.set('mood', mood);
        if (!pointer) return;
        // The point under the pointer, 120 units in front of the head.
        camera.toView(view, head.localToWorld(center, head.pivot));
        if (!camera.unproject(target, pointer.x, pointer.y, view.z + 120)) return;
        const k = gaze.point ? ease : 1;
        looked.x += (target.x - looked.x) * k;
        looked.y += (target.y - looked.y) * k;
        looked.z += (target.z - looked.z) * k;
        gaze.point = looked;
      };
      const track = (x: number, y: number) => {
        pointer = { x: x - scene.width / 2, y: y - scene.height / 2 };
      };
      const gazeHandler = {
        down: track,
        move: track,
        up: track,
        leave: () => {
          pointer = null;
        },
      };
      let last = Number.NaN;
      const pose = (time: number) => {
        const dt = time - last;
        last = time;
        // Hover is tested against the frame on screen, before the pose moves on.
        poke.update();
        follow(dt);
        if (dt >= 0 && dt <= SPRING_MAX_DT) {
          turn.update(dt);
          animator.update(dt);
          return;
        }
        turn.reset();
        for (const machine of animator.stateMachines) machine.reset();
        for (const layer of animator.layers) layer.time = time;
        animator.resetSprings();
        animator.evaluate();
      };
      const options = (pixelRatio: number) => ({
        width: scene.width,
        height: scene.height,
        pixelRatio,
        background: scene.background,
      });
      let unmount: () => void;
      if (backend === 'gl') {
        unmount = mountGL(
          container,
          controls,
          scene,
          (renderer, pixelRatio, time) => {
            pose(time);
            renderer.render(world, camera, options(pixelRatio));
          },
          { scene: world, camera },
        );
      } else {
        const renderer = new CanvasRenderer();
        unmount = mountCanvas(container, controls, scene, (ctx, pixelRatio, time) => {
          pose(time);
          renderer.render(ctx, world, camera, options(pixelRatio));
        });
      }
      const canvas = container.querySelector('canvas');
      if (!canvas) {
        unmount();
        throw new Error('The animated mascot example has no canvas.');
      }
      // A release while paused ends the press without a click.
      const pokeWhilePlaying: PointerHandler = {
        down: (x, y) => poke.down(x, y),
        move: (x, y) => poke.move(x, y),
        up: (x, y) => (controls.animate ? poke.up(x, y) : poke.leave()),
        leave: () => poke.leave(),
      };
      const unbind = bindPointer(canvas, frame, gazeHandler, pokeWhilePlaying, turn);
      return () => {
        unbind();
        unmount();
      };
    },
  };
}

export const examples: Example[] = [
  ...referenceScenes.map(fromReferenceSceneGL),
  ...engineScenes.map(fromEngineOnlySceneGL),
  clipExampleGL(),
  animatedMascotExample('gl'),
  benchmarkGL(),
  ...referenceScenes.map(fromEngineScene),
  ...engineScenes.map(fromEngineOnlyScene),
  animatedMascotExample('canvas'),
  benchmarkCanvas(),
];
