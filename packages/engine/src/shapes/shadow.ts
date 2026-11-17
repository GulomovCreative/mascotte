import type { Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import type { ParamSchema } from './params.ts';
import { Surface, type SurfaceOptions, type SurfaceOutline } from './surface.ts';

const SHADOW_PARAMS = {
  width: { kind: 'length', default: 1 },
  // A ratio, not a length; `length` gives it its check (finite, not negative).
  squash: { kind: 'length', default: 1 / 3 },
} as const satisfies ParamSchema;

export interface BlobShadowOptions extends SurfaceOptions {
  /** Width of the ellipse on screen, in scene units at the node's scale. */
  width?: number;
  /** Its height as a share of the width: a shadow is flat, a third by default. */
  squash?: number;
}

/** What a shadow is unless its options say otherwise: below everything, faint. */
export const BLOB_SHADOW_DEFAULTS = { opacity: 0.2, sortMode: 'layer', layer: -1 } as const;

/**
 * A soft shadow under a mascot: a flat ellipse `width` across and `width × squash` high, centered
 * at the node's origin, always facing the camera (seen nearly level, a shadow on the ground plane
 * would be a line). It lies in layer −1, below the rest, and faint (`BLOB_SHADOW_DEFAULTS` for
 * the node), filled black by default; of its style only the color is used. Make it a sibling of
 * the mascot's root, not its child, so it stays on the ground while the mascot hops or turns.
 * Hit testing passes through it.
 */
export class BlobShadow extends Surface<typeof SHADOW_PARAMS> {
  static override readonly typeName: string = 'BlobShadow';
  static override readonly params = SHADOW_PARAMS;
  static override readonly defaultStyle = { fill: true, stroke: 0, color: '#000000' };

  constructor(options: BlobShadowOptions = {}) {
    super({ ...BLOB_SHADOW_DEFAULTS, ...options });
  }

  get width(): number {
    return this.getParam('width');
  }
  set width(value: number) {
    this.setParam('width', value);
  }

  get squash(): number {
    return this.getParam('squash');
  }
  set squash(value: number) {
    this.setParam('squash', value);
  }

  buildOutline(camera: Camera, out: SurfaceOutline): boolean {
    const s = this.screenScale(camera);
    if (s === null) return false;
    this.toView(camera, o, 0, 0, 0);
    this.toView(camera, a, 1, 0, 0);
    const k = Math.hypot(a.x - o.x, a.y - o.y, a.z - o.z) * s;
    const rx = (this.width / 2) * k;
    ellipse(out, o.x * s, o.y * s, o.z, rx, rx * this.squash);
    // Only the color: a shadow is a filled ellipse in both backends.
    this.applyStyle(out, 0);
    out.hasStroke = false;
    out.hasFill = true;
    return true;
  }
}

/** The handle length of a quarter ellipse drawn with one cubic, per unit of radius. */
const KAPPA = 0.5522847498;

/** An ellipse of radii `rx`, `ry` centered at (`x`, `y`) at depth `z`, in four cubics. */
function ellipse(out: SurfaceOutline, x: number, y: number, z: number, rx: number, ry: number) {
  const hx = rx * KAPPA;
  const hy = ry * KAPPA;
  out.path
    .reset()
    .moveTo(x + rx, y, z)
    .cubicTo(x + rx, y + hy, x + hx, y + ry, x, y + ry, z, z, z)
    .cubicTo(x - hx, y + ry, x - rx, y + hy, x - rx, y, z, z, z)
    .cubicTo(x - rx, y - hy, x - hx, y - ry, x, y - ry, z, z, z)
    .cubicTo(x + hx, y - ry, x + rx, y - hy, x + rx, y, z, z, z)
    .close();
}

const o: Vec3 = { x: 0, y: 0, z: 0 };
const a: Vec3 = { x: 0, y: 0, z: 0 };
