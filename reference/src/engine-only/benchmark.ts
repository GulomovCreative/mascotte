import { Camera, Capsule, Cylinder, isDrawable, Node, PathShape, Sphere } from '@mascotte/engine';
import { type Euler, euler } from '@mascotte/math';

/*
 * Бенчмарк из плана: много маскотов по 300 примитивов в одной сцене. Маскот собирается
 * программно: тело, голова, уши, руки, ноги, глаза и рот (декали), остальное — пятнышки
 * шерсти на поверхности тела и головы. Поза меняется каждый кадр без выделений памяти:
 * углы создаются один раз и потом только переписываются.
 */

export interface Benchmark {
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly root: Node;
  readonly camera: Camera;
  /** Число рисуемых узлов сцены. */
  readonly drawables: number;
  /** Ставит позу всех маскотов в момент `time` (секунды). */
  pose(time: number): void;
}

export interface BenchmarkOptions {
  /** Сколько маскотов. По умолчанию 20. */
  count?: number;
  /** Сколько рисуемых узлов в одном маскоте. По умолчанию 300. */
  primitives?: number;
}

const COLUMNS = 5;
const CELL = 160;
const FUR = ['#e0861a', '#c86f10', '#f2a84a'];

interface Mascot {
  root: Node;
  head: Node;
  angles: Euler;
  headAngles: Euler;
  phase: number;
}

/** Точка на сфере радиуса `radius`: `i`-я из `n` по золотой спирали. */
function spiral(i: number, n: number, radius: number): { x: number; y: number; z: number } {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const angle = i * Math.PI * (3 - Math.sqrt(5));
  return { x: Math.cos(angle) * r * radius, y: y * radius, z: Math.sin(angle) * r * radius };
}

function buildMascot(index: number, rows: number, primitives: number): Mascot {
  const root = new Node({
    position: {
      x: ((index % COLUMNS) - (COLUMNS - 1) / 2) * CELL,
      y: (Math.floor(index / COLUMNS) - (rows - 1) / 2) * CELL,
      z: 0,
    },
  });
  const body = new Sphere({
    diameter: 56,
    position: { x: 0, y: 22, z: 0 },
    style: { stroke: 0, color: '#f6a623' },
  });
  const head = new Sphere({
    diameter: 48,
    position: { x: 0, y: -28, z: 0 },
    style: { stroke: 0, color: '#f6a623' },
  });
  root.add(body).add(head);
  let count = 2;
  for (const side of [-1, 1]) {
    head.add(
      new PathShape({
        path: [
          { type: 'move', point: { x: side * 12, y: -14, z: 0 } },
          { type: 'line', point: { x: side * 20, y: -36, z: 0 } },
        ],
        style: { stroke: 10, color: '#e0861a' },
      }),
    );
    const eye = new Node({ sortMode: 'attached', position: { x: side * 9, y: -4, z: 22 } });
    eye.add(new PathShape({ style: { stroke: 9, color: '#ffffff' } }));
    eye.add(new PathShape({ position: { x: 0, y: 0, z: 1 }, style: { stroke: 4, color: '#222' } }));
    head.add(eye);
    root.add(
      new Capsule({
        length: 26,
        diameter: 10,
        position: { x: side * 30, y: 20, z: 0 },
        rotation: euler.create(Math.PI / 2, 0, side * 0.5),
        style: { stroke: 0, color: '#e0861a' },
      }),
    );
    root.add(
      new Cylinder({
        length: 18,
        diameter: 12,
        position: { x: side * 12, y: 52, z: 0 },
        rotation: euler.create(Math.PI / 2, 0, 0),
        style: { stroke: 0, color: '#c86f10' },
      }),
    );
    // Ухо, два узла глаза, рука и нога (у ноги — бок и две крышки).
    count += 1 + 2 + 1 + 3;
  }
  head.add(
    new PathShape({
      sortMode: 'attached',
      path: [
        { type: 'move', point: { x: -6, y: 8, z: 22 } },
        { type: 'arc', corner: { x: 0, y: 14, z: 22 }, point: { x: 6, y: 8, z: 22 } },
      ],
      closed: false,
      style: { stroke: 3, color: '#8a3b12' },
    }),
  );
  count += 1;
  // Остальное — пятнышки шерсти: две трети на теле, треть на голове.
  const fur = Math.max(0, primitives - count);
  const onBody = Math.round((fur * 2) / 3);
  for (let i = 0; i < fur; i++) {
    const onHead = i >= onBody;
    const n = onHead ? fur - onBody : onBody;
    const k = onHead ? i - onBody : i;
    const point = spiral(k, n, onHead ? 24 : 28);
    (onHead ? head : body).add(
      new PathShape({
        position: point,
        style: { stroke: 4, color: FUR[i % FUR.length] as string },
      }),
    );
  }
  return {
    root,
    head,
    angles: euler.create(),
    headAngles: euler.create(),
    phase: index * 0.7,
  };
}

/** Сцена бенчмарка: `count` маскотов сеткой по 5 в ряд. */
export function buildBenchmark({ count = 20, primitives = 300 }: BenchmarkOptions = {}): Benchmark {
  const root = new Node();
  const mascots: Mascot[] = [];
  const rows = Math.max(1, Math.ceil(count / COLUMNS));
  for (let i = 0; i < count; i++) {
    const mascot = buildMascot(i, rows, primitives);
    root.add(mascot.root);
    mascots.push(mascot);
  }
  let drawables = 0;
  root.traverse((node) => {
    if (isDrawable(node)) drawables++;
  });
  return {
    width: COLUMNS * CELL,
    height: rows * CELL,
    background: '#e8f1f2',
    root,
    camera: new Camera(),
    drawables,
    pose(time) {
      for (let i = 0; i < mascots.length; i++) {
        const mascot = mascots[i] as Mascot;
        const t = time + mascot.phase;
        mascot.angles.y = Math.sin(t * 0.9) * 1.2;
        mascot.angles.x = -0.15;
        mascot.root.setRotationFromEuler(mascot.angles);
        mascot.headAngles.z = Math.sin(t * 1.7) * 0.15;
        mascot.head.setRotationFromEuler(mascot.headAngles);
      }
    },
  };
}
