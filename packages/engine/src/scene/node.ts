import {
  type Euler,
  type EulerOrder,
  euler,
  type Mat3x4,
  mat3x4,
  quat,
  type Vec3,
} from '@mascotte/math';
import { ObservedQuat, ObservedVec3 } from './observed.ts';
import { type Scene, sceneInternals } from './scene.ts';

export interface NodeOptions {
  /**
   * Stable identifier. If not given, one is generated automatically with the `~` prefix. Custom
   * identifiers cannot be empty, start with `~` or contain `/`. For a node with `owner` this is the
   * key within the owner, and the full `id` is `<owner id>/<key>`.
   */
  id?: string;
  /**
   * The solid that created this node as its part (a box face,
   * a cylinder base). Such nodes are not saved to the document separately, and picking
   * a shape under the cursor returns the owner.
   */
  owner?: Node;
  name?: string;
  position?: Readonly<Vec3>;
  /** Rotation as Euler angles; stored internally as a quaternion. */
  rotation?: Readonly<Euler>;
  /** Scale: a number for all axes or a vector. */
  scale?: number | Readonly<Vec3>;
  /** The point around which rotation and scale are applied. */
  pivot?: Readonly<Vec3>;
  visible?: boolean;
  opacity?: number;
  /** Depth sort mode, see `SortMode`. */
  sortMode?: SortMode;
  /** Depth offset for sorting: larger is closer to the viewer. ±Infinity is allowed. */
  zBias?: number;
  /** Layer for `layer` mode: negative ones are below the main content, positive ones above it. */
  layer?: number;
}

/**
 * How a node takes part in depth sorting.
 * - `auto`: by the depth of its sort point; a non-drawing node is transparent to sorting,
 *   its descendants are sorted together with its siblings;
 * - `group`: the subtree is sorted as a whole by the depth of the node's sort point,
 *   and in its own order inside;
 * - `attached`: a decal on the surface of the nearest drawable ancestor or solid
 *   (eye, mouth, spot): drawn right after it and visible only when its front face
 *   faces the camera; a hidden or turned-away decal also hides its own decals;
 * - `layer`: in the fixed layer `layer` below or above the rest of the list's content.
 *
 * A non-drawing node in `attached` or `layer` mode is sorted as a group.
 */
/** All sort modes, in the order the inspector lists them. */
export const SORT_MODES = ['auto', 'group', 'attached', 'layer'] as const;

export type SortMode = (typeof SORT_MODES)[number];

function checkSortMode(value: string): SortMode {
  if (!(SORT_MODES as readonly string[]).includes(value)) {
    throw new RangeError(`Unknown sort mode "${value}".`);
  }
  return value as SortMode;
}

let sortSettingsVersion = 0;

/**
 * Counter of sort setting changes across all nodes: `sortMode`, and `layer` in `layer`
 * mode. The sorter rebuilds its structure when it changes. `zBias`
 * and visibility (`visible`) are applied every frame and do not change the counter, so
 * animating them and blinking by hiding create no objects.
 */
export function getSortSettingsVersion(): number {
  return sortSettingsVersion;
}

function checkBias(value: number): number {
  if (Number.isNaN(value)) throw new RangeError('zBias cannot be NaN.');
  return value;
}

function checkLayer(value: number): number {
  if (!Number.isInteger(value)) throw new RangeError(`layer must be an integer, got ${value}.`);
  return value;
}

/** Prefix of automatic identifiers. It is forbidden in documents, so there are no collisions. */
export const AUTO_ID_PREFIX = '~';

let nextId = 1;

/** Separator in identifiers of solid parts. */
export const OWNER_SEPARATOR = '/';

function checkId(id: string): string {
  if (id.trim() === '') throw new RangeError('Node identifier cannot be empty.');
  if (id.startsWith(AUTO_ID_PREFIX)) {
    throw new RangeError(`Identifier "${id}" cannot start with "${AUTO_ID_PREFIX}".`);
  }
  if (id.includes(OWNER_SEPARATOR)) {
    throw new RangeError(`Identifier "${id}" cannot contain "${OWNER_SEPARATOR}".`);
  }
  return id;
}

function checkOpacity(value: number): number {
  if (Number.isNaN(value)) throw new RangeError('Opacity cannot be NaN.');
  return Math.min(1, Math.max(0, value));
}

/**
 * `Scene` access to the nodes' private state. Filled in the static block of `Node`
 * and not exported from the package.
 */
export let nodeInternals!: {
  /** Attaches the node as the scene root. */
  attachRoot(root: Node, scene: Scene): void;
  /** Detaches the root from the scene without touching the index. */
  detachRoot(root: Node): void;
};

/**
 * Scene node: a local transform and children.
 *
 * The world matrix is computed lazily. Changing position, rotation, scale or pivot
 * marks the node and its whole subtree stale, and recomputation happens on the first
 * access to `worldMatrix`. While nothing has changed, repeated accesses are free.
 *
 * Invariant: if a node's world matrix is stale, the matrices of all its descendants are stale too.
 * So marking a subtree stops at already stale nodes and costs as much
 * as the number of nodes that became stale.
 *
 * Subclasses (shapes) can override `onWorldInvalidated` to reset their caches.
 * An overridden `destroy` must call `super.destroy()`.
 */
export class Node {
  readonly id: string;
  /** The solid this node is a part of, or `null`. */
  readonly owner: Node | null;
  /** Name for the editor. Does not affect drawing. */
  name: string;

  /** Position relative to the parent. */
  readonly position: ObservedVec3;
  /**
   * Rotation relative to the parent. The quaternion must be unit: a non-unit one
   * adds scale. `setRotationFromEuler` always gives a unit one.
   */
  readonly rotation: ObservedQuat;
  readonly scale: ObservedVec3;
  /** The point in local coordinates around which rotation and scale are applied. */
  readonly pivot: ObservedVec3;

  #visible: boolean;
  #opacity: number;
  #appearanceVersion = 0;
  #sortMode: SortMode;
  #zBias: number;
  #layer: number;

  #parent: Node | null = null;
  readonly #children: Node[] = [];
  #childrenView: readonly Node[] | null = null;
  #scene: Scene | null = null;
  #destroyed = false;

  readonly #local: Mat3x4 = mat3x4.create();
  readonly #world: Mat3x4 = mat3x4.create();
  #localDirty = true;
  #worldDirty = true;
  #worldVersion = 0;

  constructor(options: NodeOptions = {}) {
    const key = options.id === undefined ? `${AUTO_ID_PREFIX}${nextId++}` : checkId(options.id);
    this.owner = options.owner ?? null;
    this.id = this.owner ? `${this.owner.id}${OWNER_SEPARATOR}${key}` : key;
    this.name = options.name ?? '';
    const invalidate = () => this.#invalidateLocal();
    const { position, scale, pivot } = options;
    this.position = new ObservedVec3(invalidate, position?.x, position?.y, position?.z);
    this.rotation = new ObservedQuat(invalidate);
    if (options.rotation) this.setRotationFromEuler(options.rotation);
    this.scale =
      typeof scale === 'number'
        ? new ObservedVec3(invalidate, scale, scale, scale)
        : new ObservedVec3(invalidate, scale?.x ?? 1, scale?.y ?? 1, scale?.z ?? 1);
    this.pivot = new ObservedVec3(invalidate, pivot?.x, pivot?.y, pivot?.z);
    this.#visible = options.visible ?? true;
    this.#opacity = checkOpacity(options.opacity ?? 1);
    this.#sortMode = checkSortMode(
      options.sortMode ?? (this.constructor as typeof Node).defaultSortMode,
    );
    this.#zBias = checkBias(options.zBias ?? 0);
    this.#layer = checkLayer(options.layer ?? 0);
  }

  /** Default sort mode for the class. */
  static readonly defaultSortMode: SortMode = 'auto';
  /**
   * Whether a node of the class is always sorted as a group (solids). Then `sortMode`
   * only determines where the group goes: in the depth list, in a layer or in decals.
   */
  static readonly sortsAsGroup: boolean = false;

  /**
   * Node type name: for labels, debugging and the document format. Given as a string rather than
   * taken from the class name, since minification changes class names.
   */
  static readonly typeName: string = 'Node';

  /** Type name of this node, see `Node.typeName`. */
  get typeName(): string {
    return (this.constructor as typeof Node).typeName;
  }

  // ----- sorting ----- //

  get sortMode(): SortMode {
    return this.#sortMode;
  }
  set sortMode(value: SortMode) {
    if (checkSortMode(value) !== this.#sortMode) {
      this.#sortMode = value;
      sortSettingsVersion++;
      this.#changed();
    }
  }

  /** Depth offset for sorting: larger is closer to the viewer. ±Infinity is allowed. */
  get zBias(): number {
    return this.#zBias;
  }
  set zBias(value: number) {
    // The offset depth is computed every frame, no structure rebuild is needed.
    const bias = checkBias(value);
    if (bias !== this.#zBias) {
      this.#zBias = bias;
      this.#changed();
    }
  }

  /** Layer for `layer` mode. */
  get layer(): number {
    return this.#layer;
  }
  set layer(value: number) {
    if (checkLayer(value) !== this.#layer) {
      this.#layer = value;
      // The layer is stored in the sorter's structure but only matters in layer mode.
      if (this.#sortMode === 'layer') sortSettingsVersion++;
      this.#changed();
    }
  }

  /**
   * The point in local coordinates whose depth the node is sorted by. Defaults to
   * the origin; shapes and solids refine it.
   */
  getSortPoint(out: Vec3): Vec3 {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }

  // ----- appearance ----- //

  get visible(): boolean {
    return this.#visible;
  }
  set visible(value: boolean) {
    if (value !== this.#visible) {
      this.#visible = value;
      this.#appearanceVersion++;
      this.#changed();
    }
  }

  /** Node opacity from 0 to 1, multiplied by the ancestors' opacity. NaN is forbidden. */
  get opacity(): number {
    return this.#opacity;
  }
  set opacity(value: number) {
    const opacity = checkOpacity(value);
    if (opacity !== this.#opacity) {
      this.#opacity = opacity;
      this.#appearanceVersion++;
      this.#changed();
    }
  }

  /**
   * Counter of changes to the node's own appearance (`visible`, `opacity` and shape style),
   * ignoring ancestors.
   */
  get appearanceVersion(): number {
    return this.#appearanceVersion;
  }

  // ----- hierarchy ----- //

  get parent(): Node | null {
    return this.#parent;
  }

  /**
   * Children in drawing order. This is an immutable snapshot: it is recreated only when
   * the set of children changes, so modifying the tree while iterating over it is safe.
   */
  get children(): readonly Node[] {
    this.#childrenView ??= Object.freeze(this.#children.slice());
    return this.#childrenView;
  }

  /** The scene the node belongs to, or `null` if it is not attached to a scene. */
  get scene(): Scene | null {
    return this.#scene;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /**
   * Adds `child` to the children at position `index` (at the end by default). If it had
   * another parent, the node is moved; the local transform is kept, so
   * the world position may change. A node from another scene is moved together with its id.
   */
  add(child: Node, index = this.#children.length): this {
    this.#assertAlive();
    child.#assertAlive();
    if (child === this || child.isAncestorOf(this)) {
      throw new Error(`Node "${child.id}" cannot be added to its own descendant.`);
    }
    if (!child.#parent && child.#scene) {
      throw new Error(`Node "${child.id}" is a scene root and cannot become a child.`);
    }
    if (!Number.isInteger(index) || index < 0 || index > this.#children.length) {
      throw new RangeError(`Index ${index} is out of range 0..${this.#children.length}.`);
    }
    const scene = this.#scene;
    const sameScene = child.#scene === scene;
    // Registering ids in the new scene checks for conflicts before any hierarchy changes.
    if (scene && !sameScene) sceneInternals.attach(scene, child);

    const oldParent = child.#parent;
    if (oldParent) oldParent.#detachChild(child);
    if (!sameScene) {
      const oldScene = child.#scene;
      if (oldScene) {
        sceneInternals.detach(oldScene, child);
        sceneInternals.touch(oldScene);
      }
      child.#setSceneRecursive(scene);
    }
    this.#children.splice(Math.min(index, this.#children.length), 0, child);
    this.#childrenView = null;
    child.#parent = this;
    // Reordering within the same parent does not change the world matrix.
    if (oldParent !== this) child.#invalidateWorld();
    if (scene) sceneInternals.touch(scene);
    return this;
  }

  /** Removes `child` from the children. Does nothing if it is not a child of this node. */
  remove(child: Node): this {
    if (child.#parent !== this) return this;
    this.#detachChild(child);
    child.#parent = null;
    const scene = this.#scene;
    if (scene) {
      child.#setSceneRecursive(null);
      sceneInternals.detach(scene, child);
      sceneInternals.touch(scene);
    }
    child.#invalidateWorld();
    return this;
  }

  removeFromParent(): this {
    this.#parent?.remove(this);
    return this;
  }

  /** Whether the node is an ancestor of `node` (not counting the node itself). */
  isAncestorOf(node: Node): boolean {
    for (let current = node.#parent; current; current = current.#parent) {
      if (current === this) return true;
    }
    return false;
  }

  /**
   * Walks the subtree depth-first, starting with the node itself. If `visit` returns `false`,
   * the walk stops and the node it stopped at is returned; otherwise `null`.
   */
  traverse(visit: (node: Node) => boolean | undefined): Node | null {
    if (visit(this) === false) return this;
    for (const child of this.children) {
      const stopped = child.traverse(visit);
      if (stopped) return stopped;
    }
    return null;
  }

  /** The first node of the subtree (including the node itself) with the given `id`. */
  findById(id: string): Node | null {
    return this.traverse((node) => node.id !== id);
  }

  // ----- transform ----- //

  setRotationFromEuler(angles: Readonly<Euler>): this {
    // The quaternion is computed into a plain object and copied with a single set call.
    quat.fromEuler(rotationScratch, angles);
    this.rotation.copy(rotationScratch);
    return this;
  }

  /** The current rotation as Euler angles in the given order. */
  getRotationEuler(out: Euler = euler.create(), order: EulerOrder = out.order): Euler {
    return quat.toEuler(out, this.rotation, order);
  }

  /** Matrix `T(position) · T(pivot) · R · S · T(−pivot)` relative to the parent. */
  get localMatrix(): Readonly<Mat3x4> {
    if (this.#localDirty) {
      mat3x4.compose(this.#local, this.position, this.rotation, this.scale, this.pivot);
      this.#localDirty = false;
    }
    return this.#local;
  }

  /** World matrix: the product of local matrices from the root to the node. */
  get worldMatrix(): Readonly<Mat3x4> {
    if (this.#worldDirty) {
      const parent = this.#parent;
      if (parent) mat3x4.multiply(this.#world, parent.worldMatrix, this.localMatrix);
      else mat3x4.copy(this.#world, this.localMatrix);
      this.#worldDirty = false;
      this.#worldVersion++;
    }
    return this.#world;
  }

  /**
   * World matrix recomputation counter. Grows on every recomputation, so geometry
   * caches can compare it to avoid projecting vertices again.
   * Reading the counter first recomputes a stale matrix.
   */
  get worldVersion(): number {
    this.worldMatrix;
    return this.#worldVersion;
  }

  getWorldPosition(out: Vec3): Vec3 {
    return mat3x4.getTranslation(out, this.worldMatrix);
  }

  /** Converts a point from the node's local coordinates to world coordinates. */
  localToWorld(out: Vec3, point: Readonly<Vec3>): Vec3 {
    return mat3x4.transformPoint(out, this.worldMatrix, point);
  }

  /**
   * Converts a point from world coordinates to local ones. Returns `null` if the world
   * matrix is degenerate (for example, scale 0 on the node or an ancestor).
   */
  worldToLocal(out: Vec3, point: Readonly<Vec3>): Vec3 | null {
    if (!mat3x4.invert(inverseScratch, this.worldMatrix)) return null;
    return mat3x4.transformPoint(out, inverseScratch, point);
  }

  /** Whether the node is visible, including ancestors. */
  get visibleInTree(): boolean {
    for (let node: Node | null = this; node; node = node.#parent) {
      if (!node.#visible) return false;
    }
    return true;
  }

  /** Opacity including ancestors. */
  get worldOpacity(): number {
    let opacity = 1;
    for (let node: Node | null = this; node; node = node.#parent) opacity *= node.#opacity;
    return opacity;
  }

  // ----- for subclasses ----- //

  /** Called when the node's world matrix becomes stale. */
  protected onWorldInvalidated(): void {}

  /**
   * For subclasses with their own appearance parameters (color, stroke): bumps `appearanceVersion`.
   */
  protected markAppearanceChanged(): void {
    this.#appearanceVersion++;
    this.#changed();
  }

  /**
   * For subclasses with their own state that changes the frame but not the appearance in
   * the sense of `appearanceVersion` (for example, path geometry): bumps `Scene.changeVersion`.
   */
  protected markChanged(): void {
    this.#changed();
  }

  // ----- lifecycle ----- //

  /**
   * Detaches the node from its parent and destroys the whole subtree. For the scene root, destroys
   * the whole scene. A repeated call does nothing.
   */
  destroy(): void {
    if (this.#destroyed) return;
    const scene = this.#scene;
    if (scene && !this.#parent) {
      scene.destroy();
      return;
    }
    this.removeFromParent();
    for (const child of this.#children) {
      child.#parent = null;
      child.destroy();
    }
    this.#children.length = 0;
    this.#childrenView = null;
    this.#destroyed = true;
  }

  // ----- internal ----- //

  #detachChild(child: Node): void {
    this.#children.splice(this.#children.indexOf(child), 1);
    this.#childrenView = null;
  }

  #invalidateLocal(): void {
    this.#localDirty = true;
    this.#invalidateWorld();
    this.#changed();
  }

  /** Tells the scene that something in it has changed (`Scene.changeVersion`). */
  #changed(): void {
    const scene = this.#scene;
    if (scene) sceneInternals.changed(scene);
  }

  #invalidateWorld(): void {
    if (this.#worldDirty) return;
    this.#worldDirty = true;
    this.onWorldInvalidated();
    for (const child of this.#children) child.#invalidateWorld();
  }

  #setSceneRecursive(scene: Scene | null): void {
    this.#scene = scene;
    for (const child of this.#children) child.#setSceneRecursive(scene);
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error(`Node "${this.id}" is destroyed.`);
  }

  static {
    nodeInternals = {
      attachRoot(root, scene) {
        root.#assertAlive();
        if (root.#parent || root.#scene) {
          throw new Error(
            `Node "${root.id}" is already part of a hierarchy and cannot be a scene root.`,
          );
        }
        sceneInternals.attach(scene, root);
        root.#setSceneRecursive(scene);
      },
      detachRoot(root) {
        root.#setSceneRecursive(null);
      },
    };
  }
}

const rotationScratch = quat.create();
const inverseScratch = mat3x4.create();
