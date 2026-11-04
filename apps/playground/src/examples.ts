import {
  type Context2D,
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
}

function fromReferenceScene(scene: ReferenceScene): Example {
  return {
    id: `reference/${scene.id}`,
    title: scene.title,
    group: 'Эталон Zdog',
    mount(container, controls) {
      // Сцена показывается в двукратном размере, поэтому и в пикселях холст вдвое больше.
      const pixelRatio = (window.devicePixelRatio || 1) * 2;
      const canvas = document.createElement('canvas');
      canvas.width = scene.width * pixelRatio;
      canvas.height = scene.height * pixelRatio;
      canvas.style.width = `${scene.width * 2}px`;
      canvas.style.maxWidth = '100%';
      container.append(canvas);
      const ctx = canvas.getContext('2d') as Context2D | null;
      if (!ctx) throw new Error('Canvas 2D недоступен');

      const root = scene.build();
      let time = 0;
      let last = performance.now();
      let raf = 0;
      const tick = (now: number) => {
        if (controls.animate) time += (now - last) / 1000;
        last = now;
        renderScene(scene, root, ctx, { pixelRatio, time });
        controls.frame();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => {
        cancelAnimationFrame(raf);
        canvas.remove();
      };
    },
  };
}

export const examples: Example[] = referenceScenes.map(fromReferenceScene);
