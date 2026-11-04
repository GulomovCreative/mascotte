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
import type { Scene } from './scene.ts';

export interface NodeOptions {
  /** Стабильный идентификатор. Если не задан, создаётся автоматически. */
  id?: string;
  name?: string;
  position?: Readonly<Vec3>;
  /** Поворот углами Эйлера; внутри хранится кватернионом. */
  rotation?: Readonly<Euler>;
  /** Масштаб: число для всех осей или вектор. */
  scale?: number | Readonly<Vec3>;
  /** Точка, вокруг которой выполняются поворот и масштаб. */
  pivot?: Readonly<Vec3>;
  visible?: boolean;
  opacity?: number;
}

let nextId = 1;

/** Идентификатор для узла без явного `id`. Документы редактора всегда задают свои. */
function generateId(): string {
  return `node-${nextId++}`;
}

/**
 * Узел сцены: локальная трансформация и дети.
 *
 * Мировая матрица считается лениво. Изменение позиции, поворота, масштаба или pivot
 * помечает узел и всё его поддерево устаревшими, а пересчёт происходит при первом
 * обращении к `worldMatrix`. Пока ничего не менялось, повторные обращения бесплатны.
 *
 * Инвариант: если мировая матрица узла устарела, устарели и матрицы всех его потомков.
 * Поэтому пометка поддерева останавливается на уже устаревших узлах.
 */
export class Node {
  readonly id: string;
  name: string;

  /** Позиция относительно родителя. */
  readonly position: ObservedVec3;
  /** Поворот относительно родителя. Кватернион должен быть единичным. */
  readonly rotation: ObservedQuat;
  readonly scale: ObservedVec3;
  /** Точка в локальных координатах, вокруг которой выполняются поворот и масштаб. */
  readonly pivot: ObservedVec3;

  visible: boolean;
  /** Непрозрачность узла от 0 до 1, умножается на непрозрачность предков. */
  opacity: number;

  #parent: Node | null = null;
  readonly #children: Node[] = [];
  #scene: Scene | null = null;
  #destroyed = false;

  readonly #local: Mat3x4 = mat3x4.create();
  readonly #world: Mat3x4 = mat3x4.create();
  #localDirty = true;
  #worldDirty = true;
  #worldVersion = 0;

  constructor(options: NodeOptions = {}) {
    this.id = options.id ?? generateId();
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
    this.visible = options.visible ?? true;
    this.opacity = options.opacity ?? 1;
  }

  // ----- иерархия ----- //

  get parent(): Node | null {
    return this.#parent;
  }

  get children(): readonly Node[] {
    return this.#children;
  }

  /** Сцена, в которую входит узел, или `null`, если он не подключён к сцене. */
  get scene(): Scene | null {
    return this.#scene;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /**
   * Добавляет `child` в дети, по умолчанию в конец. Если у него был родитель, узел
   * переносится. Локальная трансформация сохраняется, поэтому положение в мире меняется.
   */
  add(child: Node, index = this.#children.length): this {
    this.#assertAlive();
    child.#assertAlive();
    if (child === this || child.isAncestorOf(this)) {
      throw new Error(`Узел «${child.id}» нельзя добавить в собственного потомка.`);
    }
    if (!child.#parent && child.#scene) {
      throw new Error(`Узел «${child.id}» — корень сцены и не может стать дочерним.`);
    }
    if (!Number.isInteger(index) || index < 0 || index > this.#children.length) {
      throw new RangeError(`Индекс ${index} вне диапазона 0..${this.#children.length}.`);
    }
    const scene = this.#scene;
    const sameScene = child.#scene === scene;
    // Регистрация id в новой сцене проверяет конфликты до любых изменений иерархии.
    if (!sameScene) scene?.attachSubtree(child);

    const oldParent = child.#parent;
    if (oldParent) oldParent.#children.splice(oldParent.#children.indexOf(child), 1);
    if (!sameScene) {
      const oldScene = child.#scene;
      if (oldScene) {
        oldScene.detachSubtree(child);
        oldScene.markStructureChanged();
      }
      child.#setSceneRecursive(scene);
    }
    this.#children.splice(Math.min(index, this.#children.length), 0, child);
    child.#parent = this;
    child.#invalidateWorld();
    scene?.markStructureChanged();
    return this;
  }

  /** Убирает `child` из детей. Ничего не делает, если это не ребёнок этого узла. */
  remove(child: Node): this {
    const index = this.#children.indexOf(child);
    if (index === -1) return this;
    this.#children.splice(index, 1);
    child.#parent = null;
    const scene = this.#scene;
    if (scene) {
      child.#setSceneRecursive(null);
      scene.detachSubtree(child);
      scene.markStructureChanged();
    }
    child.#invalidateWorld();
    return this;
  }

  removeFromParent(): this {
    this.#parent?.remove(this);
    return this;
  }

  /** Является ли узел предком `node` (не считая самого узла). */
  isAncestorOf(node: Node): boolean {
    for (let current = node.#parent; current; current = current.#parent) {
      if (current === this) return true;
    }
    return false;
  }

  /** Обходит поддерево в глубину, начиная с самого узла. Обход прекращается, если `visit` вернёт `false`. */
  traverse(visit: (node: Node) => boolean | undefined): boolean {
    if (visit(this) === false) return false;
    for (const child of this.#children) {
      if (!child.traverse(visit)) return false;
    }
    return true;
  }

  /** Первый узел поддерева (включая сам узел) с указанным `id`. */
  findById(id: string): Node | null {
    let found: Node | null = null;
    this.traverse((node) => {
      if (node.id !== id) return true;
      found = node;
      return false;
    });
    return found;
  }

  // ----- трансформация ----- //

  setRotationFromEuler(angles: Readonly<Euler>): this {
    // Кватернион считается в обычный объект и копируется одним вызовом set.
    quat.fromEuler(rotationScratch, angles);
    this.rotation.copy(rotationScratch);
    return this;
  }

  /** Текущий поворот в виде углов Эйлера в заданном порядке. */
  getRotationEuler(out: Euler = euler.create(), order: EulerOrder = out.order): Euler {
    return quat.toEuler(out, this.rotation, order);
  }

  /** Матрица `T(position) · T(pivot) · R · S · T(−pivot)` относительно родителя. */
  get localMatrix(): Readonly<Mat3x4> {
    if (this.#localDirty) {
      mat3x4.compose(this.#local, this.position, this.rotation, this.scale, this.pivot);
      this.#localDirty = false;
    }
    return this.#local;
  }

  /** Мировая матрица: произведение локальных матриц от корня до узла. */
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
   * Счётчик пересчётов мировой матрицы. Растёт при каждом пересчёте, поэтому кэши
   * геометрии могут сравнивать его, чтобы не проецировать вершины повторно.
   */
  get worldVersion(): number {
    // Обращение к матрице гарантирует, что счётчик отражает актуальное состояние.
    this.worldMatrix;
    return this.#worldVersion;
  }

  getWorldPosition(out: Vec3): Vec3 {
    return mat3x4.getTranslation(out, this.worldMatrix);
  }

  /** Переводит точку из локальных координат узла в мировые. */
  localToWorld(out: Vec3, point: Readonly<Vec3>): Vec3 {
    return mat3x4.transformPoint(out, this.worldMatrix, point);
  }

  /**
   * Переводит точку из мировых координат в локальные. Возвращает `null`, если мировая
   * матрица вырождена (например, масштаб 0 у узла или предка).
   */
  worldToLocal(out: Vec3, point: Readonly<Vec3>): Vec3 | null {
    if (!mat3x4.invert(inverseScratch, this.worldMatrix)) return null;
    return mat3x4.transformPoint(out, inverseScratch, point);
  }

  /** Видим ли узел с учётом предков. */
  get visibleInTree(): boolean {
    for (let node: Node | null = this; node; node = node.#parent) {
      if (!node.visible) return false;
    }
    return true;
  }

  /** Непрозрачность с учётом предков. */
  get worldOpacity(): number {
    let opacity = 1;
    for (let node: Node | null = this; node; node = node.#parent) opacity *= node.opacity;
    return opacity;
  }

  // ----- жизненный цикл ----- //

  /** Отключает узел от родителя и уничтожает всё поддерево. Повторный вызов ничего не делает. */
  destroy(): void {
    if (this.#destroyed) return;
    this.removeFromParent();
    for (const child of this.#children) {
      child.#parent = null;
      child.destroy();
    }
    this.#children.length = 0;
    this.#destroyed = true;
  }

  // ----- внутреннее ----- //

  #invalidateLocal(): void {
    this.#localDirty = true;
    this.#invalidateWorld();
  }

  #invalidateWorld(): void {
    if (this.#worldDirty) return;
    this.#worldDirty = true;
    for (const child of this.#children) child.#invalidateWorld();
  }

  #setSceneRecursive(scene: Scene | null): void {
    this.#scene = scene;
    for (const child of this.#children) child.#setSceneRecursive(scene);
  }

  /** Подключает узел как корень сцены. Используется только `Scene`. */
  static attachRoot(root: Node, scene: Scene): void {
    root.#assertAlive();
    if (root.#parent || root.#scene) {
      throw new Error(`Узел «${root.id}» уже входит в иерархию и не может быть корнем сцены.`);
    }
    scene.attachSubtree(root);
    root.#setSceneRecursive(scene);
  }

  /** Отключает корень от сцены. Используется только `Scene`. */
  static detachRoot(root: Node): void {
    root.#setSceneRecursive(null);
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new Error(`Узел «${this.id}» уничтожен.`);
  }
}

const rotationScratch = quat.create();
const inverseScratch = mat3x4.create();
