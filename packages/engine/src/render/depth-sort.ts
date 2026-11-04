import type { Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import { getSortSettingsVersion, type Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { Shape } from '../shapes/shape.ts';
import { Surface } from '../shapes/surface.ts';

/** То, что рисуется: фигура с трёхмерным путём или экранная поверхность. */
export type Drawable = Shape | Surface;

export function isDrawable(node: Node): node is Drawable {
  return node instanceof Shape || node instanceof Surface;
}

/** Элемент сортировки: рисуемый узел или группа. */
interface Unit {
  readonly node: Node;
  /** Сам узел, если это рисуемый элемент; у группы — `null`. */
  readonly drawable: Drawable | null;
  /** Порядок в дереве: при равной глубине раньше рисуется то, что раньше в дереве. */
  readonly index: number;
  readonly layer: number;
  /** Члены группы (у рисуемого элемента пусто). */
  readonly members: Unit[];
  /** Декали, прикреплённые к элементу или группе: рисуются сразу после них. */
  readonly decals: Unit[];
  depth: number;
}

const local: Vec3 = { x: 0, y: 0, z: 0 };
const world: Vec3 = { x: 0, y: 0, z: 0 };
const front: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Сортировка сцены по глубине для отрисовки: возвращает рисуемые узлы от дальних
 * к ближним с учётом режимов `SortMode`, `zBias` и слоёв.
 *
 * Группой сортируются: узел в режиме `group`, составная фигура (всегда) и узел без
 * рисования в режиме `layer` или `attached`. Режим такого узла определяет, куда
 * попадает группа: в список по глубине, в слой или в декали ближайшего рисуемого
 * предка или группы.
 *
 * Структура (группы, декали, слои) собирается заново только при изменении дерева
 * или режимов и слоёв. В остальных кадрах пересчитываются глубины (вместе с `zBias`),
 * а списки досортировываются вставками: порядок между кадрами почти не меняется,
 * поэтому это быстро и не создаёт объектов. Результат — один и тот же массив,
 * перезаписываемый при каждом вызове.
 */
export class DepthSorter {
  #top: Unit[] = [];
  #scene: Scene | null = null;
  #structureVersion = -1;
  #settingsVersion = -1;
  #next = 0;
  readonly #out: Drawable[] = [];

  sort(scene: Scene, camera: Camera): readonly Drawable[] {
    if (
      scene !== this.#scene ||
      scene.structureVersion !== this.#structureVersion ||
      getSortSettingsVersion() !== this.#settingsVersion
    ) {
      this.#rebuild(scene);
    }
    const out = this.#out;
    out.length = 0;
    this.#emitList(this.#top, camera);
    return out;
  }

  // ----- структура ----- //

  #rebuild(scene: Scene): void {
    this.#scene = scene;
    this.#structureVersion = scene.structureVersion;
    this.#settingsVersion = getSortSettingsVersion();
    this.#next = 0;
    this.#top = [];
    // Корень сцены прозрачен: его дети — верхний список.
    const root = scene.root;
    if (isDrawable(root)) this.#place(root, this.#unit(root, root), this.#top, null, true);
    else for (const child of root.children) this.#add(child, this.#top, null);
  }

  #unit(node: Node, drawable: Drawable | null): Unit {
    return {
      node,
      drawable,
      index: this.#next++,
      layer: node.sortMode === 'layer' ? node.layer : 0,
      members: [],
      decals: [],
      depth: 0,
    };
  }

  /** Кладёт элемент в список или, если это декаль с опорой, в декали опоры. */
  #place(node: Node, unit: Unit, list: Unit[], anchor: Unit | null, isRoot = false): void {
    if (!isRoot && node.sortMode === 'attached' && anchor) anchor.decals.push(unit);
    else list.push(unit);
  }

  /** Добавляет узел и его потомков; `anchor` — ближайший рисуемый предок или группа. */
  #add(node: Node, list: Unit[], anchor: Unit | null): void {
    const drawable = isDrawable(node) ? node : null;
    const mode = node.sortMode;
    const type = node.constructor as typeof Node;
    const group = mode === 'group' || type.sortsAsGroup || (!drawable && mode !== 'auto');

    if (group) {
      const unit = this.#unit(node, null);
      this.#place(node, unit, list, anchor);
      let inner: Unit = unit;
      if (drawable) {
        inner = this.#unit(node, drawable);
        unit.members.push(inner);
      }
      for (const child of node.children) this.#add(child, unit.members, inner);
      return;
    }

    if (drawable) {
      const unit = this.#unit(node, drawable);
      this.#place(node, unit, list, anchor);
      for (const child of node.children) this.#add(child, list, unit);
      return;
    }

    // Узел без рисования в режиме auto прозрачен: потомки сортируются вместе с соседями.
    for (const child of node.children) this.#add(child, list, anchor);
  }

  // ----- кадр ----- //

  #emitList(list: Unit[], camera: Camera): void {
    for (const unit of list) unit.depth = this.#depth(unit.node, camera);
    insertionSort(list);
    for (const unit of list) this.#emitUnit(unit, camera);
  }

  #emitUnit(unit: Unit, camera: Camera): void {
    if (!unit.node.visibleInTree) return;
    if (unit.drawable) this.#out.push(unit.drawable);
    else this.#emitList(unit.members, camera);
    const decals = unit.decals;
    if (decals.length === 0) return;
    for (const decal of decals) decal.depth = this.#depth(decal.node, camera);
    insertionSort(decals);
    for (const decal of decals) {
      if (isFacing(decal.node, camera)) this.#emitUnit(decal, camera);
    }
  }

  #depth(node: Node, camera: Camera): number {
    node.getSortPoint(local);
    node.localToWorld(world, local);
    return camera.toView(world, world).z + node.zBias;
  }
}

/** Обращена ли лицевая сторона декали к камере: у фигур — `front`, у остальных — +z. */
function isFacing(node: Node, camera: Camera): boolean {
  if (node instanceof Shape) {
    front.x = node.front.x;
    front.y = node.front.y;
    front.z = node.front.z;
  } else {
    front.x = 0;
    front.y = 0;
    front.z = 1;
  }
  node.localToWorld(world, front);
  const facing = camera.toView(world, world).z;
  local.x = 0;
  local.y = 0;
  local.z = 0;
  node.localToWorld(front, local);
  return facing > camera.toView(front, front).z;
}

function before(a: Unit, b: Unit): boolean {
  if (a.layer !== b.layer) return a.layer < b.layer;
  if (a.depth !== b.depth) return a.depth < b.depth;
  return a.index < b.index;
}

/** Сортировка вставками: стабильна и почти линейна на почти упорядоченных данных. */
function insertionSort(list: Unit[]): void {
  for (let i = 1; i < list.length; i++) {
    const unit = list[i] as Unit;
    let j = i - 1;
    while (j >= 0 && before(unit, list[j] as Unit)) {
      list[j + 1] = list[j] as Unit;
      j--;
    }
    list[j + 1] = unit;
  }
}
