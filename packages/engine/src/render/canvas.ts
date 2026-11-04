import type { Camera } from '../scene/camera.ts';
import type { Scene } from '../scene/scene.ts';
import { DisplayList } from './display-list.ts';
import { ScreenOp, type ScreenPath } from './screen-path.ts';

/**
 * Методы двумерного контекста, которые использует отрисовка. Подходит и браузерный
 * `CanvasRenderingContext2D` (в том числе `OffscreenCanvas`), и canvas в Node.
 */
export type CanvasTarget = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'bezierCurveTo'
  | 'arc'
  | 'closePath'
  | 'stroke'
  | 'fill'
  | 'setTransform'
  | 'clearRect'
  | 'fillRect'
  | 'strokeStyle'
  | 'fillStyle'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
  | 'globalAlpha'
>;

export interface Viewport {
  /** Ширина кадра в CSS-пикселях. */
  width: number;
  /** Высота кадра в CSS-пикселях. */
  height: number;
  /** Сколько пикселей холста в одном CSS-пикселе. По умолчанию 1. */
  pixelRatio?: number;
  /** Цвет фона; без него кадр очищается до прозрачного. */
  background?: string;
}

/**
 * Отрисовка сцены в Canvas 2D. Строит список отрисовки и рисует его: центр кадра —
 * начало координат камеры. Состояние контекста (цвета, толщина, концы линий,
 * прозрачность) переключается только при изменении.
 */
export class CanvasRenderer {
  readonly list = new DisplayList();

  render(ctx: CanvasTarget, scene: Scene, camera: Camera, viewport: Viewport): void {
    const ratio = viewport.pixelRatio ?? 1;
    const width = viewport.width * ratio;
    const height = viewport.height * ratio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (viewport.background) {
      ctx.fillStyle = viewport.background;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    ctx.setTransform(ratio, 0, 0, ratio, width / 2, height / 2);
    ctx.lineJoin = 'round';

    const list = this.list.build(scene, camera);
    // Начальные значения, которые точно отличаются от первых настоящих.
    let alpha = Number.NaN;
    let lineCap = '';
    let lineWidth = Number.NaN;
    let strokeStyle = '';
    let fillStyle = '';
    for (let i = 0; i < list.count; i++) {
      const item = list.item(i);
      if (item.opacity !== alpha) {
        alpha = item.opacity;
        ctx.globalAlpha = alpha;
      }
      trace(ctx, item.path);
      if (item.hasStroke) {
        if (item.lineCap !== lineCap) {
          lineCap = item.lineCap;
          ctx.lineCap = item.lineCap;
        }
        if (item.lineWidth !== lineWidth) {
          lineWidth = item.lineWidth;
          ctx.lineWidth = lineWidth;
        }
        if (item.color !== strokeStyle) {
          strokeStyle = item.color;
          ctx.strokeStyle = strokeStyle;
        }
        ctx.stroke();
      }
      if (item.hasFill) {
        if (item.color !== fillStyle) {
          fillStyle = item.color;
          ctx.fillStyle = fillStyle;
        }
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** Повторяет экранный путь в контексте. */
function trace(ctx: CanvasTarget, path: ScreenPath): void {
  const { ops, data, opCount } = path;
  ctx.beginPath();
  let i = 0;
  for (let op = 0; op < opCount; op++) {
    switch (ops[op]) {
      case ScreenOp.move:
        ctx.moveTo(data[i] ?? 0, data[i + 1] ?? 0);
        i += 2;
        break;
      case ScreenOp.line:
        ctx.lineTo(data[i] ?? 0, data[i + 1] ?? 0);
        i += 2;
        break;
      case ScreenOp.cubic:
        ctx.bezierCurveTo(
          data[i] ?? 0,
          data[i + 1] ?? 0,
          data[i + 2] ?? 0,
          data[i + 3] ?? 0,
          data[i + 4] ?? 0,
          data[i + 5] ?? 0,
        );
        i += 6;
        break;
      case ScreenOp.arc:
        ctx.arc(
          data[i] ?? 0,
          data[i + 1] ?? 0,
          data[i + 2] ?? 0,
          data[i + 3] ?? 0,
          data[i + 4] ?? 0,
          data[i + 5] === 1,
        );
        i += 6;
        break;
    }
  }
  if (path.closed) ctx.closePath();
}
