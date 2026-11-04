import { type ReferenceScene, referenceScenes, renderScene } from '@mascotte/reference';

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

function fromReferenceScene(scene: ReferenceScene): Example {
  return {
    id: `reference/${scene.id}`,
    title: scene.title,
    group: 'Эталон Zdog',
    mount(container, controls) {
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

      const root = scene.build();
      let time = 0;
      let last = performance.now();
      let raf = 0;
      const tick = (now: number) => {
        try {
          if (controls.animate) time += (now - last) / 1000;
          last = now;
          renderScene(scene, root, ctx, { pixelRatio, time });
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
    },
  };
}

export const examples: Example[] = referenceScenes.map(fromReferenceScene);
