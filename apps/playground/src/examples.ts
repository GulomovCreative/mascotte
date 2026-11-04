import { Camera, CanvasRenderer, Scene, WebGLRenderer } from '@mascotte/engine';
import {
  type EngineScene,
  engineScenes,
  type ReferenceScene,
  referenceScenes,
  renderScene,
} from '@mascotte/reference';

/** Пример в playground: монтируется в контейнер и возвращает функцию очистки. */
export interface Example {
  id: string;
  title: string;
  group: string;
  mount(container: HTMLElement, controls: ExampleControls): () => void;
}

export interface ExampleControls {
  /** Включена ли анимация. Пример читает значение в каждом кадре. */
  readonly animate: boolean;
  /** Сообщает о прошедшем кадре для счётчика fps. */
  frame(): void;
  /** Сообщает об ошибке в цикле кадра. После неё пример останавливается. */
  error(error: unknown): void;
}

/** Сцена показывается в двукратном размере. */
const displayScale = 2;

/**
 * Вызывает `callback` при каждой смене devicePixelRatio: перенос окна на другой монитор
 * или изменение масштаба страницы. Возвращает функцию отписки.
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

type Draw = (ctx: CanvasRenderingContext2D, pixelRatio: number, time: number) => void;

/** Холст с циклом кадров и учётом devicePixelRatio. */
function mountCanvas(
  container: HTMLElement,
  controls: ExampleControls,
  scene: Pick<ReferenceScene, 'width' | 'height'>,
  draw: Draw,
): () => void {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D недоступен в этом браузере.');
  canvas.style.width = `${scene.width * displayScale}px`;
  canvas.style.maxWidth = '100%';

  let pixelRatio = 1;
  const resize = () => {
    pixelRatio = (window.devicePixelRatio || 1) * displayScale;
    canvas.width = scene.width * pixelRatio;
    canvas.height = scene.height * pixelRatio;
  };
  resize();
  const unwatch = watchPixelRatio(resize);
  container.append(canvas);

  let time = 0;
  let last = performance.now();
  let raf = 0;
  const tick = (now: number) => {
    try {
      if (controls.animate) time += (now - last) / 1000;
      last = now;
      draw(ctx, pixelRatio, time);
      controls.frame();
    } catch (error) {
      controls.error(error);
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    unwatch();
    canvas.remove();
  };
}

type DrawGL = (renderer: WebGLRenderer, pixelRatio: number, time: number) => void;

/** Холст WebGL2 с циклом кадров. */
function mountGL(
  container: HTMLElement,
  controls: ExampleControls,
  scene: Pick<ReferenceScene, 'width' | 'height'>,
  draw: DrawGL,
): () => void {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${scene.width * displayScale}px`;
  canvas.style.maxWidth = '100%';
  const renderer = new WebGLRenderer(canvas);
  let pixelRatio = 1;
  const resize = () => {
    pixelRatio = (window.devicePixelRatio || 1) * displayScale;
    canvas.width = scene.width * pixelRatio;
    canvas.height = scene.height * pixelRatio;
  };
  resize();
  const unwatch = watchPixelRatio(resize);
  container.append(canvas);
  let time = 0;
  let last = performance.now();
  let raf = 0;
  const tick = (now: number) => {
    try {
      if (controls.animate) time += (now - last) / 1000;
      last = now;
      draw(renderer, pixelRatio, time);
      controls.frame();
    } catch (error) {
      controls.error(error);
      return;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    unwatch();
    renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
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
      return mountGL(container, controls, scene, (renderer, pixelRatio, time) => {
        scene.engine.pose(root, time);
        renderer.render(world, camera, {
          width: scene.width,
          height: scene.height,
          pixelRatio,
          background: scene.background,
        });
      });
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
      return mountGL(container, controls, scene, (renderer, pixelRatio, time) => {
        scene.pose(root, camera, time);
        renderer.render(world, camera, {
          width: scene.width,
          height: scene.height,
          pixelRatio,
          background: scene.background,
        });
      });
    },
  };
}

function fromReferenceScene(scene: ReferenceScene): Example {
  return {
    id: `reference/${scene.id}`,
    title: scene.title,
    group: 'Эталон Zdog',
    mount(container, controls) {
      const root = scene.build();
      return mountCanvas(container, controls, scene, (ctx, pixelRatio, time) => {
        renderScene(scene, root, ctx, { pixelRatio, time });
      });
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

export const examples: Example[] = [
  ...referenceScenes.map(fromReferenceSceneGL),
  ...engineScenes.map(fromEngineOnlySceneGL),
  ...referenceScenes.map(fromEngineScene),
  ...engineScenes.map(fromEngineOnlyScene),
  ...referenceScenes.map(fromReferenceScene),
];
