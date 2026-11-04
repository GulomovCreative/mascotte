import type { Node } from '@mascotte/engine';
import type { Anchor, CanvasContext } from '@mascotte/zdog-reference';

/** Та же сцена на новом ядре. Повороты Zdog {x, y, z} переводятся в {x, -y, z}. */
export interface EngineVersion {
  /** Строит корень сцены. */
  build(): Node;
  /** Положение сцены в момент `time`, как `pose` у версии Zdog. */
  pose(root: Node, time: number): void;
}

/** Эталонная сцена: строится копией Zdog и служит образцом картинки для нового ядра. */
export interface ReferenceScene {
  readonly id: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  /** Цвет фона кадра. */
  readonly background: string;
  /** Масштаб сцены, как `zoom` в Zdog. */
  readonly zoom: number;
  /** Строит граф сцены и возвращает его корень. */
  build(): Anchor;
  /** Положение сцены в момент `time` (секунды). Для снимков используется `time = 0`. */
  pose?(root: Anchor, time: number): void;
  /** Та же сцена на новом ядре: её кадр сравнивается со снимком Zdog. */
  readonly engine: EngineVersion;
}

/** Двумерный контекст, общий для браузерного canvas и canvas в Node. */
export type Context2D = CanvasContext &
  Pick<
    CanvasRenderingContext2D,
    | 'save'
    | 'restore'
    | 'setTransform'
    | 'translate'
    | 'scale'
    | 'fillRect'
    | 'lineCap'
    | 'lineJoin'
  >;

export interface RenderOptions {
  pixelRatio?: number;
  time?: number;
}

/** Рисует кадр сцены в контекст размером `width × height × pixelRatio`. */
export function renderScene(
  scene: ReferenceScene,
  root: Anchor,
  ctx: Context2D,
  { pixelRatio = 1, time = 0 }: RenderOptions = {},
): void {
  scene.pose?.(root, time);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, scene.width * pixelRatio, scene.height * pixelRatio);
  ctx.translate((scene.width * pixelRatio) / 2, (scene.height * pixelRatio) / 2);
  const scale = pixelRatio * scene.zoom;
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  root.updateGraph();
  root.renderGraphCanvas(ctx);
  ctx.restore();
}
