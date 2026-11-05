import type { Camera } from '../scene/camera.ts';
import type { Scene } from '../scene/scene.ts';
import { DisplayList, type DisplayListOptions } from './display-list.ts';
import { ScreenOp, type ScreenPath } from './screen-path.ts';

/**
 * 2D context methods used by drawing. The browser
 * `CanvasRenderingContext2D`, the `OffscreenCanvas` context and canvas in Node all fit.
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
  | 'save'
  | 'restore'
  | 'clip'
>;

export interface Viewport {
  /** Frame width in CSS pixels. */
  width: number;
  /** Frame height in CSS pixels. */
  height: number;
  /** How many canvas pixels are in one CSS pixel. Defaults to 1. */
  pixelRatio?: number;
  /** Background color; without it the frame is cleared to transparent. */
  background?: string;
}

/**
 * Scene rendering in Canvas 2D. Builds the display list and draws it: the frame center
 * is the camera origin. Within a frame the context state (colors, width,
 * line caps, opacity) is switched only when it changes.
 */
export class CanvasRenderer {
  readonly list: DisplayList;

  constructor(options: DisplayListOptions = {}) {
    this.list = new DisplayList(options);
  }

  render(ctx: CanvasTarget, scene: Scene, camera: Camera, viewport: Viewport): void {
    const ratio = checkViewport(viewport);
    const width = viewport.width * ratio;
    const height = viewport.height * ratio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Clearing is required even with a background: otherwise a translucent background would
    // accumulate over previous frames.
    ctx.clearRect(0, 0, width, height);
    if (viewport.background) {
      ctx.fillStyle = viewport.background;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.setTransform(ratio, 0, 0, ratio, width / 2, height / 2);
    ctx.lineJoin = 'round';

    const list = this.list.build(scene, camera);
    // Initial values that are certain to differ from the first real ones.
    let alpha = Number.NaN;
    let lineCap = '';
    let lineWidth = Number.NaN;
    let strokeStyle = '';
    let fillStyle = '';
    for (let i = 0; i < list.count; i++) {
      const item = list.item(i);
      const clipped = item.clip === 'circle';
      if (clipped) {
        // After restore the context returns to its state before save: the cache is reset too.
        ctx.save();
        ctx.beginPath();
        ctx.arc(item.clipX, item.clipY, item.clipRadius, 0, Math.PI * 2);
        ctx.clip();
      }
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
      if (clipped) {
        ctx.restore();
        alpha = Number.NaN;
        lineCap = '';
        lineWidth = Number.NaN;
        strokeStyle = '';
        fillStyle = '';
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** Validates the frame size and returns devicePixelRatio. */
function checkViewport(viewport: Viewport): number {
  const ratio = viewport.pixelRatio ?? 1;
  const ok = (value: number) => value >= 0 && Number.isFinite(value);
  if (!ok(viewport.width) || !ok(viewport.height)) {
    throw new RangeError(
      `Frame size must be finite and non-negative: ${viewport.width}×${viewport.height}.`,
    );
  }
  if (!(ratio > 0 && Number.isFinite(ratio))) {
    throw new RangeError(`pixelRatio must be a positive finite number, got ${ratio}.`);
  }
  return ratio;
}

/** Replays a screen path in the context. */
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
