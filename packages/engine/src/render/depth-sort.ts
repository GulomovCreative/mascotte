import type { Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import { getSortSettingsVersion, type Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { Shape } from '../shapes/shape.ts';
import { Surface } from '../shapes/surface.ts';

/** What gets drawn: a shape with a 3D path or a screen surface. */
export type Drawable = Shape | Surface;

export function isDrawable(node: Node): node is Drawable {
  return node instanceof Shape || node instanceof Surface;
}

/** Sort item: a drawable or a group. */
interface Unit {
  readonly node: Node;
  /** The node itself if this is a drawable; `null` for a group. */
  readonly drawable: Drawable | null;
  /** Tree order: at equal depth, what comes earlier in the tree is drawn first. */
  readonly index: number;
  readonly layer: number;
  /** Group members (empty for a drawable). */
  readonly members: Unit[];
  /** Decals attached to the item or group: drawn right after them. */
  readonly decals: Unit[];
  depth: number;
}

const local: Vec3 = { x: 0, y: 0, z: 0 };
const world: Vec3 = { x: 0, y: 0, z: 0 };
const front: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Depth sorting of the scene for drawing: returns drawables from far
 * to near, taking into account `SortMode` modes, `zBias` and layers.
 *
 * Sorted as a group: a node in `group` mode, a solid (always) and a non-drawing
 * node in `layer` or `attached` mode. The mode of such a node determines where
 * the group goes: into the depth list, into a layer or into the decals of the nearest drawable
 * ancestor or group.
 *
 * The structure (groups, decals, layers) is rebuilt only when the tree
 * or the modes and layers change. In other frames the depths are recomputed (together with `zBias`),
 * and the lists are re-sorted by insertion: the order barely changes between frames,
 * so this is fast and creates no objects. The result is one and the same array,
 * overwritten on every call.
 */
export class DepthSorter {
  #top: Unit[] = [];
  #scene: Scene | null = null;
  #structureVersion = -1;
  #settingsVersion = -1;
  #next = 0;
  // The result and run numbers are written by index, the length is set at the end: resetting
  // an array's length in V8 frees its memory, and every frame would allocate it again.
  readonly #out: Drawable[] = [];
  #outCount = 0;
  readonly #runs: number[] = [];
  // Layers on the path from the top list to the current item, and the path of the current run.
  readonly #path: number[] = [];
  #pathLength = 0;
  readonly #runPath: number[] = [];
  #runPathLength = 0;
  #run = 0;

  sort(scene: Scene, camera: Camera): readonly Drawable[] {
    if (
      scene !== this.#scene ||
      scene.structureVersion !== this.#structureVersion ||
      getSortSettingsVersion() !== this.#settingsVersion
    ) {
      this.#rebuild(scene);
    }
    const out = this.#out;
    this.#outCount = 0;
    this.#pathLength = 0;
    this.#runPathLength = 0;
    this.#run = 0;
    this.#emitList(this.#top, camera);
    if (out.length !== this.#outCount) out.length = this.#outCount;
    if (this.#runs.length !== this.#outCount) this.#runs.length = this.#outCount;
    return out;
  }

  /**
   * Layer run number for each item of the last result. A run is consecutive
   * items with the same layer path from the top list (zero layers at the end
   * of the path do not count). Numbers grow from zero. Drawing with a depth buffer tests
   * depth only within a run: this way a layer under content stays under it even
   * if it is closer to the camera.
   */
  get runs(): readonly number[] {
    return this.#runs;
  }

  // ----- structure ----- //

  #rebuild(scene: Scene): void {
    this.#scene = scene;
    this.#structureVersion = scene.structureVersion;
    this.#settingsVersion = getSortSettingsVersion();
    this.#next = 0;
    this.#top = [];
    // The scene root is transparent: its children are the top list.
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

  /** Puts the item into a list or, if it is a decal with an anchor, into the anchor's decals. */
  #place(node: Node, unit: Unit, list: Unit[], anchor: Unit | null, isRoot = false): void {
    if (!isRoot && node.sortMode === 'attached' && anchor) anchor.decals.push(unit);
    else list.push(unit);
  }

  /** Adds a node and its descendants; `anchor` is the nearest drawable ancestor or group. */
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

    // A non-drawing node in auto mode is transparent: its descendants are sorted together with its siblings.
    for (const child of node.children) this.#add(child, list, anchor);
  }

  // ----- frame ----- //

  #emitList(list: Unit[], camera: Camera): void {
    for (let i = 0; i < list.length; i++) this.#depth(list[i] as Unit, camera);
    insertionSort(list);
    for (let i = 0; i < list.length; i++) this.#emitUnit(list[i] as Unit, camera);
  }

  #emitUnit(unit: Unit, camera: Camera): void {
    if (!unit.node.visibleInTree) return;
    this.#path[this.#pathLength++] = unit.layer;
    if (unit.drawable) this.#push(unit.drawable);
    else this.#emitList(unit.members, camera);
    const decals = unit.decals;
    if (decals.length > 0) {
      for (let i = 0; i < decals.length; i++) this.#depth(decals[i] as Unit, camera);
      insertionSort(decals);
      for (let i = 0; i < decals.length; i++) {
        const decal = decals[i] as Unit;
        if (isFacing(decal.node, camera)) this.#emitUnit(decal, camera);
      }
    }
    this.#pathLength--;
  }

  /** Adds an item to the result and records its layer run. */
  #push(drawable: Drawable): void {
    const path = this.#path;
    const runPath = this.#runPath;
    let n = this.#pathLength;
    while (n > 0 && path[n - 1] === 0) n--;
    let same = n === this.#runPathLength;
    for (let i = 0; same && i < n; i++) same = path[i] === runPath[i];
    if (!same) {
      if (this.#outCount > 0) this.#run++;
      this.#runPathLength = n;
      for (let i = 0; i < n; i++) runPath[i] = path[i] as number;
    }
    this.#runs[this.#outCount] = this.#run;
    this.#out[this.#outCount++] = drawable;
  }

  /** Item depth into `unit.depth`: written in place, without returning a float. */
  #depth(unit: Unit, camera: Camera): void {
    const node = unit.node;
    node.getSortPoint(local);
    node.localToWorld(world, local);
    unit.depth = camera.toView(world, world).z + node.zBias;
  }
}

/** Whether the decal's front face faces the camera: `front` for shapes, +z for the rest. */
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

/** Insertion sort: stable and nearly linear on nearly sorted data. */
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
