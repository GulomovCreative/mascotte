import type { Anchor } from '@mascotte/zdog-reference';

/** Эталонная сцена: строится копией Zdog и служит образцом картинки для нового ядра. */
export interface ReferenceScene {
  id: string;
  title: string;
  width: number;
  height: number;
  /** Цвет фона кадра. */
  background: string;
  /** Масштаб сцены, как `zoom` в Zdog. */
  zoom: number;
  /** Строит граф сцены и возвращает его корень. */
  build(): Anchor;
  /** Положение сцены в момент `time` (секунды). Для снимков используется `time = 0`. */
  pose?(root: Anchor, time: number): void;
}

/** Двумерный контекст, общий для браузерного canvas и canvas в Node. */
export type Context2D = Pick<
  CanvasRenderingContext2D,
  | 'save'
  | 'restore'
  | 'setTransform'
  | 'translate'
  | 'scale'
  | 'fillRect'
  | 'fillStyle'
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
  root.renderGraphCanvas(ctx as CanvasRenderingContext2D);
  ctx.restore();
}
