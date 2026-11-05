import { ScreenOp, type ScreenPath } from './screen-path.ts';

/*
 * Partial occlusion: a stroke that passes behind an occluder is cut into the part behind it (drawn
 * before the occluder) and the part in front of it (drawn after).
 *
 * - A sphere cuts with its front surface: a point is hidden if on screen it is inside the
 *   silhouette and deeper than the front surface. This is exact even for shapes that go inside the
 *   sphere, for example an ear growing out of a head.
 * - A capsule cuts with a plane perpendicular to the view, through the middle of the axis. When the
 *   capsule tilts toward the view, this is an approximation.
 *
 * Path coordinates are in screen space (pixels), depth is in camera space units.
 */

/** What cuts the path. */
export interface Cutter {
  kind: 'sphere' | 'plane';
  /** Sphere center on screen, pixels. */
  x: number;
  y: number;
  /** Depth of the sphere center or of the plane. */
  depth: number;
  /** Sphere silhouette radius, pixels. */
  radius: number;
  /** Pixels per unit of depth at the sphere center: to compare screen distance and depth. */
  scale: number;
}

/**
 * Sign: a negative value means the point is behind the occluder, a non-negative one means in front
 * of it.
 */
export function cutValue(cutter: Readonly<Cutter>, x: number, y: number, z: number): number {
  if (cutter.kind === 'plane') return z - cutter.depth;
  const dx = (x - cutter.x) / cutter.scale;
  const dy = (y - cutter.y) / cutter.scale;
  const r = cutter.radius / cutter.scale;
  const inside = r * r - dx * dx - dy * dy;
  // Outside the silhouette the sphere covers nothing.
  if (inside <= 0) return 1;
  return z - (cutter.depth + Math.sqrt(inside));
}

/** Where the parts are written: `[behind the occluder, in front of it]`. */
export type SplitTarget = readonly [ScreenPath, ScreenPath];

type Side = 0 | 1;

const pen = { x: 0, y: 0, z: 0, continuing: [false, false] as [boolean, boolean] };

function sideOf(value: number): Side {
  return value < 0 ? 0 : 1;
}

/** Starts a piece of side `side` at the current pen point, unless that side continues from it. */
function start(target: SplitTarget, side: Side): ScreenPath {
  const path = target[side];
  if (!pen.continuing[side]) {
    path.moveTo(pen.x, pen.y, pen.z);
    pen.continuing[side] = true;
  }
  pen.continuing[side === 0 ? 1 : 0] = false;
  return path;
}

function bezier(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

// The segment or curve being cut now: points by t.
const seg = {
  cubic: false,
  x: [0, 0, 0, 0],
  y: [0, 0, 0, 0],
  z: [0, 0, 0, 0],
};

function at(t: number, axis: number[]): number {
  if (seg.cubic) {
    return bezier(axis[0] as number, axis[1] as number, axis[2] as number, axis[3] as number, t);
  }
  return (axis[0] as number) + ((axis[3] as number) - (axis[0] as number)) * t;
}

function valueAt(cutter: Readonly<Cutter>, t: number): number {
  return cutValue(cutter, at(t, seg.x), at(t, seg.y), at(t, seg.z));
}

/** At most this many side changes on one piece. */
const MAX_ROOTS = 8;
const roots = new Float64Array(MAX_ROOTS);
const SAMPLES = 24;

/** Values of `t` on (0, 1) where the piece crosses the cutting surface. */
function crossings(cutter: Readonly<Cutter>): number {
  let count = 0;
  let prevT = 0;
  let prev = valueAt(cutter, 0) < 0;
  for (let i = 1; i <= SAMPLES && count < MAX_ROOTS; i++) {
    const t = i / SAMPLES;
    const behind = valueAt(cutter, t) < 0;
    if (behind !== prev) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (valueAt(cutter, mid) < 0 === prev) lo = mid;
        else hi = mid;
      }
      roots[count++] = (lo + hi) / 2;
    }
    prevT = t;
    prev = behind;
  }
  return count;
}

const part = [0, 0, 0, 0];

/** Control points of a curve piece on [t0, t1] for one coordinate (de Casteljau). */
function subCurve(axis: number[], t0: number, t1: number): void {
  let p0 = axis[0] as number;
  let p1 = axis[1] as number;
  let p2 = axis[2] as number;
  let p3 = axis[3] as number;
  if (t0 > 0) {
    const ab = p0 + (p1 - p0) * t0;
    const bc = p1 + (p2 - p1) * t0;
    const cd = p2 + (p3 - p2) * t0;
    const abc = ab + (bc - ab) * t0;
    const bcd = bc + (cd - bc) * t0;
    p0 = abc + (bcd - abc) * t0;
    p1 = bcd;
    p2 = cd;
  }
  const s = t0 < 1 ? (t1 - t0) / (1 - t0) : 1;
  if (s < 1) {
    const ab = p0 + (p1 - p0) * s;
    const bc = p1 + (p2 - p1) * s;
    const cd = p2 + (p3 - p2) * s;
    const abc = ab + (bc - ab) * s;
    const bcd = bc + (cd - bc) * s;
    p1 = ab;
    p2 = abc;
    p3 = abc + (bcd - abc) * s;
  }
  part[0] = p0;
  part[1] = p1;
  part[2] = p2;
  part[3] = p3;
}

/** Cuts the current piece (`seg`, starting at the pen) and appends the parts to `target`. */
function cutSegment(cutter: Readonly<Cutter>, target: SplitTarget): void {
  const count = crossings(cutter);
  let t0 = 0;
  for (let i = 0; i <= count; i++) {
    const t1 = i < count ? (roots[i] as number) : 1;
    const side = sideOf(valueAt(cutter, (t0 + t1) / 2));
    const path = start(target, side);
    if (seg.cubic) {
      subCurve(seg.x, t0, t1);
      const ax = part[1] as number;
      const bx = part[2] as number;
      const ex = part[3] as number;
      subCurve(seg.y, t0, t1);
      const ay = part[1] as number;
      const by = part[2] as number;
      const ey = part[3] as number;
      subCurve(seg.z, t0, t1);
      path.cubicTo(ax, ay, bx, by, ex, ey, part[1] as number, part[2] as number, part[3] as number);
      pen.x = ex;
      pen.y = ey;
      pen.z = part[3] as number;
    } else {
      pen.x = at(t1, seg.x);
      pen.y = at(t1, seg.y);
      pen.z = at(t1, seg.z);
      path.lineTo(pen.x, pen.y, pen.z);
    }
    // At a piece boundary the other side continues from this same point.
    if (i < count) pen.continuing[side] = false;
    t0 = t1;
  }
}

function setLine(x: number, y: number, z: number): void {
  seg.cubic = false;
  seg.x[0] = pen.x;
  seg.y[0] = pen.y;
  seg.z[0] = pen.z;
  seg.x[3] = x;
  seg.y[3] = y;
  seg.z[3] = z;
}

/**
 * Cuts a path with depths by the `cutter` surface and appends the parts to `target`: `[0]` is
 * behind the occluder, `[1]` is in front of it. The parts are not closed: the closing segment
 * of a closed path is cut the same way as the others. Arcs are skipped: strokes being cut
 * have none.
 */
export function splitPath(path: ScreenPath, cutter: Readonly<Cutter>, target: SplitTarget): void {
  const { ops, data, depths, opCount } = path;
  let d = 0;
  let p = 0;
  let startX = 0;
  let startY = 0;
  let startZ = 0;
  pen.continuing[0] = false;
  pen.continuing[1] = false;
  for (let op = 0; op < opCount; op++) {
    switch (ops[op]) {
      case ScreenOp.move:
        pen.x = data[d] ?? 0;
        pen.y = data[d + 1] ?? 0;
        pen.z = depths[p] ?? 0;
        startX = pen.x;
        startY = pen.y;
        startZ = pen.z;
        pen.continuing[0] = false;
        pen.continuing[1] = false;
        d += 2;
        p += 1;
        break;
      case ScreenOp.line:
        setLine(data[d] ?? 0, data[d + 1] ?? 0, depths[p] ?? 0);
        cutSegment(cutter, target);
        d += 2;
        p += 1;
        break;
      case ScreenOp.cubic:
        seg.cubic = true;
        seg.x[0] = pen.x;
        seg.y[0] = pen.y;
        seg.z[0] = pen.z;
        for (let k = 0; k < 3; k++) {
          seg.x[k + 1] = data[d + k * 2] ?? 0;
          seg.y[k + 1] = data[d + k * 2 + 1] ?? 0;
          seg.z[k + 1] = depths[p + k] ?? 0;
        }
        cutSegment(cutter, target);
        d += 6;
        p += 3;
        break;
      case ScreenOp.arc:
        d += 6;
        break;
    }
  }
  if (path.closed) {
    setLine(startX, startY, startZ);
    cutSegment(cutter, target);
  }
}
