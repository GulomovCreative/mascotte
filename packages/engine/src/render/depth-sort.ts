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
  /** Сам узел, если он рисуется, иначе `null` (группа без своего рисования). */
  readonly drawable: Drawable | null;
  /** Порядок в дереве: при равной глубине раньше рисуется то, что раньше в дереве. */
  readonly index: number;
  readonly layer: number;
  readonly group: boolean;
  /** У группы — её члены, у рисуемого узла — прикреплённые к нему декали. */
  readonly children: Unit[];
  depth: number;
}

const local: Vec3 = { x: 0, y: 0, z: 0 };
const world: Vec3 = { x: 0, y: 0, z: 0 };
const front: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Сортировка сцены по глубине для отрисовки: возвращает рисуемые узлы от дальних
 * к ближним с учётом режимов `SortMode`, `zBias` и слоёв.
 *
 * Структура (группы, декали, слои) собирается заново только при изменении дерева
 * или настроек сортировки. В остальных кадрах пересчитываются глубины, а списки
 * досортировываются вставками: порядок между кадрами почти не меняется, поэтому это
 * быстро и не создаёт объектов. Результат — один и тот же массив, перезаписываемый
 * при каждом вызове.
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
    this.#add(scene.root, this.#top, null, true);
  }

  #unit(node: Node, drawable: Drawable | null, group: boolean): Unit {
    return {
      node,
      drawable,
      index: this.#next++,
      layer: node.sortMode === 'layer' ? node.layer : 0,
      group,
      children: [],
      depth: 0,
    };
  }

  /** Добавляет узел и его потомков в список `list`; `anchor` — ближайший рисуемый предок. */
  #add(node: Node, list: Unit[], anchor: Unit | null, isRoot = false): void {
    const drawable = isDrawable(node) ? node : null;
    const mode = node.sortMode;

    if (mode === 'group' && !isRoot) {
      const group = this.#unit(node, null, true);
      list.push(group);
      let inner: Unit | null = null;
      if (drawable) {
        inner = this.#unit(node, drawable, false);
        group.children.push(inner);
      }
      for (const child of node.children) this.#add(child, group.children, inner);
      return;
    }

    if (drawable && mode === 'attached' && anchor) {
      const unit = this.#unit(node, drawable, false);
      anchor.children.push(unit);
      for (const child of node.children) this.#add(child, list, unit);
      return;
    }

    if (drawable) {
      const unit = this.#unit(node, drawable, false);
      list.push(unit);
      for (const child of node.children) this.#add(child, list, unit);
      return;
    }

    // Узел без рисования прозрачен: потомки сортируются вместе с его соседями.
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
    if (unit.group) {
      this.#emitList(unit.children, camera);
      return;
    }
    if (unit.drawable) this.#out.push(unit.drawable);
    const decals = unit.children;
    if (decals.length === 0) return;
    for (const decal of decals) decal.depth = this.#depth(decal.node, camera);
    insertionSort(decals);
    for (const decal of decals) {
      if (decal.drawable && isFacing(decal.drawable, camera)) this.#emitUnit(decal, camera);
    }
  }

  #depth(node: Node, camera: Camera): number {
    node.getSortPoint(local);
    node.localToWorld(world, local);
    return camera.toView(world, world).z + node.zBias;
  }
}

/** Обращена ли лицевая сторона декали к камере. */
function isFacing(drawable: Drawable, camera: Camera): boolean {
  if (drawable instanceof Shape) {
    front.x = drawable.front.x;
    front.y = drawable.front.y;
    front.z = drawable.front.z;
  } else {
    front.x = 0;
    front.y = 0;
    front.z = 1;
  }
  drawable.localToWorld(world, front);
  const facing = camera.toView(world, world).z;
  local.x = 0;
  local.y = 0;
  local.z = 0;
  drawable.localToWorld(front, local);
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
