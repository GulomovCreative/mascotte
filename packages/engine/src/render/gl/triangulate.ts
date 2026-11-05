import type { IndexBuffer } from './buffer.ts';

/**
 * Splits a simple polygon into triangles by ear clipping.
 * `xs`, `ys` are the vertices in order (without repeating the first). Writes index triples to `out`
 * and returns the number of triangles. For a self-intersecting polygon, where the ears
 * ran out early, the rest is split as a fan. Allocates no memory while the buffers
 * are large enough.
 */
export function triangulate(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  n: number,
  out: IndexBuffer,
): number {
  out.reset();
  if (n < 3) return 0;
  // Orientation from the sign of the area: ears are searched for a counterclockwise traversal.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += (xs[i] as number) * (ys[j] as number) - (xs[j] as number) * (ys[i] as number);
  }
  const sign = area >= 0 ? 1 : -1;
  if (ring.length < n) ring = new Int32Array(Math.max(n, ring.length * 2));
  for (let i = 0; i < n; i++) ring[i] = i;
  let size = n;
  let guard = 0;
  while (size > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < size; i++) {
      const a = ring[(i + size - 1) % size] as number;
      const b = ring[i] as number;
      const c = ring[(i + 1) % size] as number;
      if (!isEar(xs, ys, a, b, c, sign, ring, size)) continue;
      out.push(a);
      out.push(b);
      out.push(c);
      // Remove vertex i from the ring.
      ring.copyWithin(i, i + 1, size);
      size--;
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  // The rest (usually exactly one triangle) as a fan.
  for (let i = 1; i + 1 < size; i++) {
    out.push(ring[0] as number);
    out.push(ring[i] as number);
    out.push(ring[i + 1] as number);
  }
  return out.length / 3;
}

// Ring of remaining vertices, shared by all calls.
let ring = new Int32Array(64);

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function isEar(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  sign: number,
  ring: Int32Array,
  size: number,
): boolean {
  const ax = xs[a] as number;
  const ay = ys[a] as number;
  const bx = xs[b] as number;
  const by = ys[b] as number;
  const cx = xs[c] as number;
  const cy = ys[c] as number;
  if (cross(ax, ay, bx, by, cx, cy) * sign <= 0) return false;
  for (let i = 0; i < size; i++) {
    const p = ring[i] as number;
    if (p === a || p === b || p === c) continue;
    const px = xs[p] as number;
    const py = ys[p] as number;
    if (
      cross(ax, ay, bx, by, px, py) * sign >= 0 &&
      cross(bx, by, cx, cy, px, py) * sign >= 0 &&
      cross(cx, cy, ax, ay, px, py) * sign >= 0
    ) {
      return false;
    }
  }
  return true;
}
