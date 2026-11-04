/**
 * Разбивает простой многоугольник на треугольники методом отрезания ушей.
 * `xs`, `ys` — вершины по порядку (без повтора первой). Пишет тройки индексов в `out`
 * и возвращает число треугольников. Для самопересекающегося многоугольника, где уши
 * кончились раньше, остаток разбивается веером.
 */
export function triangulate(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  n: number,
  out: number[],
): number {
  out.length = 0;
  if (n < 3) return 0;
  // Ориентация по знаку площади: уши ищутся для обхода против часовой.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += (xs[i] as number) * (ys[j] as number) - (xs[j] as number) * (ys[i] as number);
  }
  const sign = area >= 0 ? 1 : -1;
  const ring = indices;
  ring.length = 0;
  for (let i = 0; i < n; i++) ring.push(i);
  let guard = 0;
  while (ring.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length] as number;
      const b = ring[i] as number;
      const c = ring[(i + 1) % ring.length] as number;
      if (!isEar(xs, ys, a, b, c, sign, ring)) continue;
      out.push(a, b, c);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  // Остаток (обычно ровно один треугольник) — веером.
  for (let i = 1; i + 1 < ring.length; i++)
    out.push(ring[0] as number, ring[i] as number, ring[i + 1] as number);
  return out.length / 3;
}

const indices: number[] = [];

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
  ring: number[],
): boolean {
  const ax = xs[a] as number;
  const ay = ys[a] as number;
  const bx = xs[b] as number;
  const by = ys[b] as number;
  const cx = xs[c] as number;
  const cy = ys[c] as number;
  if (cross(ax, ay, bx, by, cx, cy) * sign <= 0) return false;
  for (const p of ring) {
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
