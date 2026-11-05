import { Camera, CanvasRenderer, HitTester, Scene, WebGLRenderer } from '@mascotte/engine';
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

/** Тип узла и его id, если id задан, а не создан автоматически. */
function nodeLabel(node: { id: string; typeName: string }): string {
  return node.id.startsWith('~') ? node.typeName : `${node.typeName} «${node.id}»`;
}

/** Что показывать под холстом при наведении: сцена и камера примера. */
interface HitSource {
  scene: Scene;
  camera: Camera;
}

/** Подпись под холстом с узлом под указателем. */
interface HitLabel {
  /** Пересчитать попадание: вызывается после каждого кадра, ведь фигуры двигаются. */
  update(): void;
  /** Убрать подпись и обработчики. */
  dispose(): void;
}

/**
 * Подпись под холстом с узлом под указателем: проверка попадания по текущему кадру.
 * Движение указателя только запоминает точку, а попадание считается один раз после
 * каждого кадра — так фигура, уехавшая из-под неподвижного указателя, не числится под
 * ним, и сцена не обходится дважды за кадр.
 */
function showHits(
  container: HTMLElement,
  canvas: HTMLCanvasElement,
  size: { width: number; height: number },
  pick: HitSource,
): HitLabel {
  const label = document.createElement('p');
  label.className = 'hit';
  const idle = 'Наведите указатель на фигуру.';
  label.textContent = idle;
  container.append(label);
  const tester = new HitTester();
  // Указатель в пикселях кадра или null, если он вне холста.
  let pointer: { x: number; y: number } | null = null;
  const update = () => {
    if (!pointer) return;
    const hit = tester.hitTest(pick.scene, pick.camera, size, pointer.x, pointer.y);
    canvas.style.cursor = hit ? 'pointer' : '';
    const text = hit
      ? hit.node === hit.drawable
        ? `Под указателем: ${nodeLabel(hit.node)}`
        : `Под указателем: ${nodeLabel(hit.node)}, часть ${nodeLabel(hit.drawable)}`
      : 'Под указателем ничего нет.';
    if (label.textContent !== text) label.textContent = text;
  };
  const move = (event: PointerEvent) => {
    // Холст может быть ужат по ширине: переводим в пиксели кадра.
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

/** Холст WebGL2 с циклом кадров. */
function mountGL(
  container: HTMLElement,
  controls: ExampleControls,
  scene: Pick<ReferenceScene, 'width' | 'height'>,
  draw: DrawGL,
  pick?: HitSource,
): () => void {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${scene.width * displayScale}px`;
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
    pixelRatio = (window.devicePixelRatio || 1) * displayScale;
    canvas.width = scene.width * pixelRatio;
    canvas.height = scene.height * pixelRatio;
  };
  resize();
  const unwatch = watchPixelRatio(resize);
  container.append(canvas);
  const hits = pick ? showHits(container, canvas, scene, pick) : null;
  let time = 0;
  let last = performance.now();
  let raf = 0;
  const tick = (now: number) => {
    try {
      if (controls.animate) time += (now - last) / 1000;
      last = now;
      draw(renderer, pixelRatio, time);
      hits?.update();
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
