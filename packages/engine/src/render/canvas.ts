import type { Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import type { Scene } from '../scene/scene.ts';
import type { SurfaceOutline } from '../shapes/surface.ts';
import { DisplayList, type DisplayListOptions } from './display-list.ts';
import { ScreenOp, type ScreenPath } from './screen-path.ts';
import { HIGHLIGHT_ABOVE, SHADOW_BELOW } from './tone.ts';

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
  | 'ellipse'
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
      if (item.shade !== 'none') {
        // Shaded: the brush changes several times, the state cache starts over.
        // упрощение: тона рисуются слоями поверх основы, поэтому у полупрозрачной фигуры они
        // просвечивают друг через друга (WebGL даёт один цвет на пиксель); вернуться, если
        // тонированные фигуры станут полупрозрачными (затухание маскота целиком).
        if (item.shade === 'sphere') shadeSphere(ctx, item, camera.light);
        else shadeCapsule(ctx, item, camera.light);
        lineCap = '';
        lineWidth = Number.NaN;
        strokeStyle = '';
        fillStyle = '';
      } else {
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

/** Draws the item's own brush: its stroke, then its fill, in `color`. */
function paint(ctx: CanvasTarget, item: SurfaceOutline, color: string): void {
  trace(ctx, item.path);
  if (item.hasStroke) {
    ctx.lineCap = item.lineCap;
    ctx.lineWidth = item.lineWidth;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  if (item.hasFill) {
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/**
 * A shaded sphere: the item in its color, then the shadow and the highlight over its circle,
 * outlined exactly. The terminator (n·l = 0, `SHADOW_BELOW`) is a great circle, seen as an
 * ellipse through the ends of the circle's diameter across the light: the shadow is the dark
 * half of the circle without the ellipse (light in front) or with it (light behind). The
 * highlight is the spot n·l > `HIGHLIGHT_ABOVE`, a small circle on the sphere seen as an ellipse.
 * упрощение: блик считается целиком видимым; при свете почти сбоку (light.z мал) его задняя часть
 * рисуется зря; вернуться, если такой свет понадобится.
 */
function shadeSphere(ctx: CanvasTarget, item: SurfaceOutline, light: Readonly<Vec3>): void {
  paint(ctx, item, item.color);
  const x = item.shadeX;
  const y = item.shadeY;
  const r = item.shadeRadius;
  // The light's direction on screen (any, if it shines along the view).
  const sideways = Math.hypot(light.x, light.y) > 1e-9;
  const theta = sideways ? Math.atan2(light.y, light.x) : 0;
  // The outline assumes the terminator at n·l = 0 (`SHADOW_BELOW`; a test pins it).
  if (item.shadowColor !== null) {
    ctx.beginPath();
    if (sideways) {
      ctx.arc(x, y, r, theta + Math.PI / 2, theta + (3 * Math.PI) / 2);
      const minor = r * Math.abs(light.z);
      if (light.z >= 0) ctx.ellipse(x, y, minor, r, theta, (3 * Math.PI) / 2, Math.PI / 2, true);
      else ctx.ellipse(x, y, minor, r, theta, -Math.PI / 2, Math.PI / 2);
    } else if (light.z < 0) ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = item.shadowColor;
    ctx.fill();
  }
  if (item.highlightColor !== null && light.z > 0) {
    const h = HIGHLIGHT_ABOVE;
    const spot = r * Math.sqrt(1 - h * h);
    ctx.beginPath();
    ctx.ellipse(
      x + r * h * light.x,
      y + r * h * light.y,
      spot * light.z,
      spot,
      theta,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = item.highlightColor;
    ctx.fill();
  }
}

/**
 * A shaded capsule (or a part of a cut one): its stroke in the shadow color, then the lit part
 * and the highlight over it. Across a tube the normal turns by an angle α from the view,
 * n·l = k·cos(α − β), so each tone is a band of α, between two lines along the axis. A band
 * that reaches the capsule's side is drawn as the whole capsule shifted across the axis and
 * clipped to it, so its ends round off like a lit sphere's; a band inside is a narrower stroke.
 * упрощение: полосы считаются как у трубки в плоскости экрана: наклон оси к зрителю и свет вдоль
 * оси (на торцах) не учитываются; WebGL считает точно.
 */
function shadeCapsule(ctx: CanvasTarget, item: SurfaceOutline, light: Readonly<Vec3>): void {
  paint(ctx, item, item.shadowColor ?? item.color);
  const ax = item.shadeX2 - item.shadeX;
  const ay = item.shadeY2 - item.shadeY;
  const length = Math.hypot(ax, ay);
  if (!(length > 0)) return;
  // Across the axis on screen, and the light's part in the plane across the axis.
  const wx = -ay / length;
  const wy = ax / length;
  const lw = light.x * wx + light.y * wy;
  const k = Math.hypot(lw, light.z);
  const beta = Math.atan2(lw, light.z);
  const r = item.shadeRadius;
  const data = item.path.data;
  const x0 = data[0] ?? 0;
  const y0 = data[1] ?? 0;
  const x1 = data[2] ?? 0;
  const y1 = data[3] ?? 0;
  const angle = Math.atan2(y1 - y0, x1 - x0);
  ctx.save();
  // The item's own capsule: the whole one, or its part between the cuts.
  ctx.beginPath();
  ctx.arc(x1, y1, r, angle - Math.PI / 2, angle + Math.PI / 2);
  ctx.arc(x0, y0, r, angle + Math.PI / 2, angle + (3 * Math.PI) / 2);
  ctx.closePath();
  ctx.clip();
  ctx.lineCap = item.lineCap;
  if (item.shadowColor !== null && k > SHADOW_BELOW) {
    band(ctx, item, wx, wy, beta, Math.acos(Math.min(1, SHADOW_BELOW / k)), item.color);
  }
  if (item.highlightColor !== null && k > HIGHLIGHT_ABOVE) {
    band(ctx, item, wx, wy, beta, Math.acos(HIGHLIGHT_ABOVE / k), item.highlightColor);
  }
  ctx.restore();
}

/**
 * One tone of a shaded capsule: the band of normals within `half` of `beta` (see `shadeCapsule`),
 * across the axis `(wx, wy)`.
 */
function band(
  ctx: CanvasTarget,
  item: SurfaceOutline,
  wx: number,
  wy: number,
  beta: number,
  half: number,
  color: string,
): void {
  const r = item.shadeRadius;
  const lo = Math.sin(Math.max(-Math.PI / 2, beta - half));
  const hi = Math.sin(Math.min(Math.PI / 2, beta + half));
  if (!(hi > lo)) return;
  let shift: number;
  let width: number;
  // Reaching a side: the whole capsule, shifted so its other side is at the band's edge.
  if (hi >= 1 - 1e-9) {
    width = 2 * r;
    shift = r * (lo + 1);
  } else if (lo <= -1 + 1e-9) {
    width = 2 * r;
    shift = r * (hi - 1);
  } else {
    width = r * (hi - lo);
    shift = (r * (lo + hi)) / 2;
  }
  trace(ctx, item.path, wx * shift, wy * shift);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

/** Replays a screen path in the context, shifted by (`dx`, `dy`). */
function trace(ctx: CanvasTarget, path: ScreenPath, dx = 0, dy = 0): void {
  const { ops, data, opCount } = path;
  ctx.beginPath();
  let i = 0;
  for (let op = 0; op < opCount; op++) {
    switch (ops[op]) {
      case ScreenOp.move:
        ctx.moveTo((data[i] ?? 0) + dx, (data[i + 1] ?? 0) + dy);
        i += 2;
        break;
      case ScreenOp.line:
        ctx.lineTo((data[i] ?? 0) + dx, (data[i + 1] ?? 0) + dy);
        i += 2;
        break;
      case ScreenOp.cubic:
        ctx.bezierCurveTo(
          (data[i] ?? 0) + dx,
          (data[i + 1] ?? 0) + dy,
          (data[i + 2] ?? 0) + dx,
          (data[i + 3] ?? 0) + dy,
          (data[i + 4] ?? 0) + dx,
          (data[i + 5] ?? 0) + dy,
        );
        i += 6;
        break;
      case ScreenOp.arc:
        ctx.arc(
          (data[i] ?? 0) + dx,
          (data[i + 1] ?? 0) + dy,
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
