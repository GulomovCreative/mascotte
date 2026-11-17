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
      const clipped = item.clip === 'circle' || item.sphereCuts.length > 0;
      if (clipped) {
        // After restore the context returns to its state before save: the cache is reset too.
        ctx.save();
        if (item.clip === 'circle') {
          ctx.beginPath();
          ctx.arc(item.clipX, item.clipY, item.clipRadius, 0, Math.PI * 2);
          ctx.clip();
        }
        // A decal is cut as its anchor.
        const base = item.cutBase ?? item;
        let shown = true;
        for (let k = 0; k < item.sphereCuts.length && shown; k++) {
          shown = clipSphereCut(ctx, base, item.sphereCuts[k] as SurfaceOutline);
        }
        if (!shown) {
          // Nothing of its front shows outside a sphere drawn before it.
          ctx.restore();
          alpha = Number.NaN;
          lineCap = '';
          lineWidth = Number.NaN;
          strokeStyle = '';
          fillStyle = '';
          continue;
        }
      }
      if (item.opacity !== alpha) {
        alpha = item.opacity;
        ctx.globalAlpha = alpha;
      }
      if (item.outlineWidth > 0) {
        // The outline: the item's path stroked wider, just behind it.
        // упрощение: обводка — целая полоса под фигурой, поэтому у полупрозрачной фигуры её
        // внутренняя половина просвечивает, а у части обводки, разрезанной окклюдером, на разрезе
        // круглый конец (WebGL рисует только внешнее кольцо, без разрезов); вернуться, если
        // обведённые фигуры станут полупрозрачными или разрез станет заметен.
        trace(ctx, item.path);
        ctx.lineCap = 'round';
        ctx.lineWidth = (item.hasStroke ? item.lineWidth : 0) + 2 * item.outlineWidth;
        ctx.strokeStyle = item.outlineColor;
        ctx.stroke();
        lineCap = 'round';
        lineWidth = Number.NaN;
        strokeStyle = item.outlineColor;
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

const TAU = Math.PI * 2;

/** How many segments a sphere cut's arc of the intersection circle is drawn with. */
const CUT_STEPS = 24;

/**
 * The circle where two spheres meet, on the cut sphere: center (`x`, `y`) and radius `r` on
 * screen, the cap's axis `u`, and P(φ) = h·u + s·(cos φ·e1 + sin φ·e2), e1 across `u` in the
 * screen plane and e2 = u × e1. Reused, so a cut allocates nothing.
 */
const circle = { x: 0, y: 0, r: 0, h: 0, s: 0, ux: 0, uy: 0, e1x: 0, e1y: 0, e2x: 0, e2y: 0 };

/** Adds the circle's point at angle `phi` to the path, moving there if `move`. */
function circlePoint(ctx: CanvasTarget, phi: number, move: boolean): void {
  const c = circle;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const px = c.x + c.r * (c.h * c.ux + c.s * (cos * c.e1x + sin * c.e2x));
  const py = c.y + c.r * (c.h * c.uy + c.s * (cos * c.e1y + sin * c.e2y));
  if (move) ctx.moveTo(px, py);
  else ctx.lineTo(px, py);
}

/** The screen angle, around the sphere's center, of the circle's point at angle `phi`. */
function circleAngle(phi: number): number {
  const c = circle;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  return Math.atan2(
    c.h * c.uy + c.s * (cos * c.e1y + sin * c.e2y),
    c.h * c.ux + c.s * (cos * c.e1x + sin * c.e2x),
  );
}

/**
 * Clips the context to the part of `item`'s sphere outside `other`'s, a sphere drawn before it
 * that it reaches into, with `item`'s outline. Returns `false` if nothing of its front shows.
 * Both spheres are in screen 3D (pixels, depth scaled alike). The part of the item's sphere
 * inside the other is a cap around the direction `u` towards the other's center, bounded by the
 * circle where the spheres meet: the points whose unit normal n has n·u > h. Seen from the front
 * it is one of:
 * - the region between the circle's front arc and the item's silhouette (the circle crosses the
 *   silhouette): cut out of the item's disk with the even-odd rule;
 * - the inside of the circle (all in front, `u` towards the viewer): cut out the same way;
 * - all but the inside of the circle (all in front, `u` away): the clip keeps the inside;
 * - all or nothing (the circle all behind).
 * This matches WebGL's depth where the spheres overlap; elsewhere the draw order decides, as
 * for any two shapes in Canvas 2D.
 * упрощение: глубина в экранном 3D берётся с масштабом перспективы каждой сферы, так что у сфер
 * с разными опорными узлами перспективы срез слегка расходится с WebGL; вернуться, если такие
 * сферы будут пересекаться в маскотах.
 */
function clipSphereCut(ctx: CanvasTarget, item: SurfaceOutline, other: SurfaceOutline): boolean {
  const r = item.occluderRadius;
  const x = item.occluderX;
  const y = item.occluderY;
  // The disk the cut is taken out of, with the item's outline around its silhouette.
  const outer = r + item.outlineWidth;
  const dx = other.occluderX - x;
  const dy = other.occluderY - y;
  const dz = other.occluderDepth * other.occluderScale - item.occluderDepth * item.occluderScale;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const ra = other.occluderRadius;
  if (d + r <= ra) return false;
  if (!(d > 0)) return true;
  const ux = dx / d;
  const uy = dy / d;
  const uz = dz / d;
  const h = (d * d + r * r - ra * ra) / (2 * d * r);
  const s = Math.sqrt(Math.max(0, 1 - h * h));
  // Spheres just touching: the cap is a point (nothing to cut) or the whole sphere.
  if (!(s > 0)) return h > 0;
  const across = Math.hypot(ux, uy);
  const c = circle;
  c.x = x;
  c.y = y;
  c.r = r;
  c.h = h;
  c.s = s;
  c.ux = ux;
  c.uy = uy;
  c.e1x = across > 1e-9 ? -uy / across : 1;
  c.e1y = across > 1e-9 ? ux / across : 0;
  c.e2x = -uz * c.e1y;
  c.e2y = uz * c.e1x;
  const e2z = ux * c.e1y - uy * c.e1x;
  // The circle's point is in front where P.z = h·uz + s·sin φ·e2z > 0.
  const k = s * e2z;
  const front = h * uz;
  ctx.beginPath();
  if (Math.abs(k) <= Math.abs(front)) {
    if (front < 0) {
      // The circle is all behind: the cap is behind (nothing to cut) or holds the whole front.
      if (uz > 0) return false;
      clipOutlineOver(ctx, item, other);
      return true;
    }
    // The circle is all in front.
    ctx.arc(x, y, outer, 0, TAU);
    ctx.closePath();
    if (uz <= 0 && item.outlineWidth > 0) {
      // The cap holds the rest of the front: the circle's inside shows, and the outline band.
      ctx.arc(x, y, r, 0, TAU);
      ctx.closePath();
    } else if (uz <= 0) {
      ctx.beginPath();
    }
    for (let i = 0; i <= CUT_STEPS; i++) circlePoint(ctx, (i / CUT_STEPS) * TAU, i === 0);
    ctx.closePath();
    ctx.clip(uz > 0 || item.outlineWidth > 0 ? 'evenodd' : 'nonzero');
    clipOutlineOver(ctx, item, other);
    return true;
  }
  // The circle crosses the silhouette: its front arc, and the silhouette back around the side
  // the cap is on (towards u).
  const phi = Math.asin(-front / k);
  const from = k > 0 ? phi : Math.PI - phi;
  const to = k > 0 ? Math.PI - phi : TAU + phi;
  ctx.arc(x, y, outer, 0, TAU);
  ctx.closePath();
  for (let i = 0; i <= CUT_STEPS; i++)
    circlePoint(ctx, from + ((to - from) * i) / CUT_STEPS, i === 0);
  const end = circleAngle(to);
  const start = circleAngle(from);
  // Clockwise from the arc's end back to its start passes the cap's side, or the other way.
  const toward = Math.atan2(uy, ux);
  const sweep = (((start - end) % TAU) + TAU) % TAU;
  const offset = (((toward - end) % TAU) + TAU) % TAU;
  ctx.arc(x, y, r, end, start, !(offset < sweep));
  ctx.closePath();
  ctx.clip('evenodd');
  clipOutlineOver(ctx, item, other);
  return true;
}

/** Far enough to hold any frame: the bounds of a clip that keeps all but some disks. */
const FAR = 1e6;

/**
 * Keeps the item's outline where WebGL's depth keeps its ring: the ring stands a pixel behind the
 * item's front (depth `zb`), so over `other` it shows only where `other`'s surface is deeper,
 * outside a circle around `other`'s center (all of `other`'s disk if `zb` is not in front of its
 * center). The clip is everything but that circle, the item's own disk given back (nonzero
 * winding: the frame and the item's disk turn one way, the circle the other way).
 */
function clipOutlineOver(ctx: CanvasTarget, item: SurfaceOutline, other: SurfaceOutline): void {
  if (!(item.outlineWidth > 0)) return;
  const zb = item.occluderDepth * item.occluderScale + item.occluderRadius - 1;
  const za = other.occluderDepth * other.occluderScale;
  const ra = other.occluderRadius;
  const rise = zb - za;
  const hidden = rise > 0 ? Math.sqrt(Math.max(0, ra * ra - rise * rise)) : ra;
  if (!(hidden > 0)) return;
  ctx.beginPath();
  ctx.moveTo(-FAR, -FAR);
  ctx.lineTo(FAR, -FAR);
  ctx.lineTo(FAR, FAR);
  ctx.lineTo(-FAR, FAR);
  ctx.closePath();
  ctx.moveTo(other.occluderX + hidden, other.occluderY);
  ctx.arc(other.occluderX, other.occluderY, hidden, TAU, 0, true);
  ctx.closePath();
  ctx.moveTo(item.occluderX + item.occluderRadius, item.occluderY);
  ctx.arc(item.occluderX, item.occluderY, item.occluderRadius, 0, TAU);
  ctx.closePath();
  ctx.clip();
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
