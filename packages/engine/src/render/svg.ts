import type { Camera } from '../scene/camera.ts';
import type { Scene } from '../scene/scene.ts';
import { CanvasRenderer, type CanvasTarget, type Viewport } from './canvas.ts';
import type { DisplayListOptions } from './display-list.ts';

const TAU = Math.PI * 2;

/**
 * A number for SVG: three decimals at most, no `-0`. Not finite, it would break the markup that
 * holds it (a path stops, a transform drops its group), so it throws.
 */
function n(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`SVG export: a number is ${value}.`);
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded === 0 ? 0 : rounded);
}

/** XML-escapes an attribute value (colors come from documents). */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

interface DrawState {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  /** How many `<g>` this state opened (clips), closed on restore. */
  groups: number;
}

/**
 * A `CanvasTarget` that writes SVG: every fill and stroke becomes a `<path>`, a clip a
 * `<clipPath>` with a group, and the transform a group. The Canvas 2D renderer drives it
 * unchanged, so the SVG is the same picture as its frame, as vectors.
 */
class SvgTarget {
  readonly #body: string[] = [];
  readonly #defs: string[] = [];
  #path = '';
  /** Whether the subpath has a current point (else the next segment starts with `M`). */
  #hasPoint = false;
  #state: DrawState = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    groups: 0,
  };
  readonly #stack: DrawState[] = [];
  #transformOpen = false;
  #clips = 0;

  get fillStyle(): string {
    return this.#state.fillStyle;
  }
  set fillStyle(value: string) {
    this.#state.fillStyle = value;
  }
  get strokeStyle(): string {
    return this.#state.strokeStyle;
  }
  set strokeStyle(value: string) {
    this.#state.strokeStyle = value;
  }
  get lineWidth(): number {
    return this.#state.lineWidth;
  }
  set lineWidth(value: number) {
    // As in Canvas, a width that is not positive and finite is ignored.
    if (value > 0 && Number.isFinite(value)) this.#state.lineWidth = value;
  }
  get lineCap(): string {
    return this.#state.lineCap;
  }
  set lineCap(value: string) {
    this.#state.lineCap = value;
  }
  get lineJoin(): string {
    return this.#state.lineJoin;
  }
  set lineJoin(value: string) {
    this.#state.lineJoin = value;
  }
  get globalAlpha(): number {
    return this.#state.globalAlpha;
  }
  set globalAlpha(value: number) {
    if (value >= 0 && value <= 1) this.#state.globalAlpha = value;
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    // The renderer sets the transform outside any clip (identity for the background, then the
    // frame's): each call closes the previous group.
    if (this.#transformOpen) this.#body.push('</g>');
    this.#body.push(`<g transform="matrix(${[a, b, c, d, e, f].map(n).join(' ')})">`);
    this.#transformOpen = true;
  }

  clearRect(): void {
    // A frame starts empty: nothing to clear.
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.#body.push(
      `<rect x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}" fill="${attr(this.#state.fillStyle)}"/>`,
    );
  }

  beginPath(): void {
    this.#path = '';
    this.#hasPoint = false;
  }

  moveTo(x: number, y: number): void {
    this.#path += `M${n(x)} ${n(y)}`;
    this.#hasPoint = true;
  }

  lineTo(x: number, y: number): void {
    this.#path += `${this.#hasPoint ? 'L' : 'M'}${n(x)} ${n(y)}`;
    this.#hasPoint = true;
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!this.#hasPoint) this.moveTo(c1x, c1y);
    this.#path += `C${[c1x, c1y, c2x, c2y, x, y].map(n).join(' ')}`;
  }

  closePath(): void {
    if (this.#hasPoint) this.#path += 'Z';
  }

  arc(x: number, y: number, r: number, start: number, end: number, ccw = false): void {
    this.ellipse(x, y, r, r, 0, start, end, ccw);
  }

  /**
   * An elliptical arc as Canvas draws it: from `start` to `end` (radians of the ellipse's own
   * parameter), clockwise unless `ccw`, a whole turn at most; a line joins it to the subpath.
   */
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rotation: number,
    start: number,
    end: number,
    ccw = false,
  ): void {
    let sweep = end - start;
    if (ccw ? sweep <= -TAU : sweep >= TAU) sweep = ccw ? -TAU : TAU;
    else if (ccw) sweep = -((((start - end) % TAU) + TAU) % TAU);
    else sweep = ((sweep % TAU) + TAU) % TAU;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const at = (t: number): [number, number] => {
      const px = Math.cos(t) * rx;
      const py = Math.sin(t) * ry;
      return [x + px * cos - py * sin, y + px * sin + py * cos];
    };
    const [sx, sy] = at(start);
    this.#path += `${this.#hasPoint ? 'L' : 'M'}${n(sx)} ${n(sy)}`;
    this.#hasPoint = true;
    if (sweep === 0) return;
    // SVG cannot draw a whole turn in one arc: at most halves.
    const parts = Math.ceil(Math.abs(sweep) / Math.PI - 1e-9);
    const degrees = n((rotation * 180) / Math.PI);
    for (let i = 1; i <= parts; i++) {
      const [px, py] = at(start + (sweep * i) / parts);
      const large = Math.abs(sweep / parts) > Math.PI ? 1 : 0;
      this.#path += `A${n(rx)} ${n(ry)} ${degrees} ${large} ${ccw ? 0 : 1} ${n(px)} ${n(py)}`;
    }
  }

  #paint(kind: 'fill' | 'stroke'): void {
    if (this.#path === '') return;
    const s = this.#state;
    const opacity = s.globalAlpha < 1 ? ` opacity="${n(s.globalAlpha)}"` : '';
    if (kind === 'fill') {
      this.#body.push(`<path d="${this.#path}" fill="${attr(s.fillStyle)}"${opacity}/>`);
    } else {
      this.#body.push(
        `<path d="${this.#path}" fill="none" stroke="${attr(s.strokeStyle)}" stroke-width="${n(s.lineWidth)}" stroke-linecap="${s.lineCap}" stroke-linejoin="${s.lineJoin}"${opacity}/>`,
      );
    }
  }

  fill(): void {
    this.#paint('fill');
  }

  stroke(): void {
    this.#paint('stroke');
  }

  save(): void {
    this.#stack.push(this.#state);
    this.#state = { ...this.#state, groups: 0 };
  }

  restore(): void {
    const previous = this.#stack.pop();
    if (!previous) return;
    for (let i = 0; i < this.#state.groups; i++) this.#body.push('</g>');
    this.#state = previous;
  }

  clip(): void {
    const id = `c${this.#clips++}`;
    this.#defs.push(`<clipPath id="${id}"><path d="${this.#path}"/></clipPath>`);
    this.#body.push(`<g clip-path="url(#${id})">`);
    this.#state.groups++;
  }

  /** The SVG document, `width` × `height` canvas pixels. */
  document(width: number, height: number): string {
    while (this.#stack.length > 0) this.restore();
    // A clip made without a save stays open in the base state: close it too.
    for (let i = 0; i < this.#state.groups; i++) this.#body.push('</g>');
    this.#state.groups = 0;
    const close = this.#transformOpen ? '</g>' : '';
    const defs = this.#defs.length > 0 ? `<defs>${this.#defs.join('')}</defs>` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">${defs}${this.#body.join('')}${close}</svg>`;
  }
}

/**
 * Exports a frame as SVG: the Canvas 2D renderer draws it into a target that writes vectors, so
 * the SVG shows what `CanvasRenderer` would (tones, outlines, clipped decals and all), at
 * `viewport.width × pixelRatio` by `viewport.height × pixelRatio`. Works without a browser.
 */
export class SvgRenderer {
  readonly #canvas: CanvasRenderer;

  constructor(options: DisplayListOptions = {}) {
    this.#canvas = new CanvasRenderer(options);
  }

  /** The SVG of the frame. */
  render(scene: Scene, camera: Camera, viewport: Viewport): string {
    const target = new SvgTarget();
    this.#canvas.render(target as unknown as CanvasTarget, scene, camera, viewport);
    const ratio = viewport.pixelRatio ?? 1;
    return target.document(viewport.width * ratio, viewport.height * ratio);
  }
}
