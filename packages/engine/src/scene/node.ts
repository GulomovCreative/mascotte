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
   * Стабильный идентификатор. Если не задан, создаётся автоматически с префиксом `~`.
   * Свои идентификаторы не могут быть пустыми, начинаться с `~` и содержать `/`.
   * У узла с `owner` это ключ внутри владельца, а полный `id` — `«id владельца»/«ключ»`.
   */
  id?: string;
  /**
   * Составная фигура, которая создала этот узел как свою часть (грань коробки,
   * основание цилиндра). Такие узлы не сохраняются в документ отдельно, а поиск
   * фигуры под курсором возвращает владельца.
   */
  owner?: Node;
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

/** Префикс автоматических идентификаторов. Документам он запрещён, поэтому совпадений нет. */
export const AUTO_ID_PREFIX = '~';

let nextId = 1;

/** Разделитель в идентификаторах частей составной фигуры. */
export const OWNER_SEPARATOR = '/';

function checkId(id: string): string {
  if (id.trim() === '') throw new RangeError('Идентификатор узла не может быть пустым.');
  if (id.startsWith(AUTO_ID_PREFIX)) {
    throw new RangeError(`Идентификатор «${id}» не может начинаться с «${AUTO_ID_PREFIX}».`);
  }
  if (id.includes(OWNER_SEPARATOR)) {
    throw new RangeError(`Идентификатор «${id}» не может содержать «${OWNER_SEPARATOR}».`);
  }
  return id;
}

function checkOpacity(value: number): number {
  if (Number.isNaN(value)) throw new RangeError('Непрозрачность не может быть NaN.');
  return Math.min(1, Math.max(0, value));
}

/**
 * Доступ `Scene` к закрытому состоянию узлов. Заполняется в статическом блоке `Node`
 * и не экспортируется из пакета.
 */
export let nodeInternals!: {
  /** Подключает узел как корень сцены. */
  attachRoot(root: Node, scene: Scene): void;
  /** Отключает корень от сцены, не трогая индекс. */
  detachRoot(root: Node): void;
};

/**
 * Узел сцены: локальная трансформация и дети.
 *
 * Мировая матрица считается лениво. Изменение позиции, поворота, масштаба или pivot
 * помечает узел и всё его поддерево устаревшими, а пересчёт происходит при первом
 * обращении к `worldMatrix`. Пока ничего не менялось, повторные обращения бесплатны.
 *
 * Инвариант: если мировая матрица узла устарела, устарели и матрицы всех его потомков.
 * Поэтому пометка поддерева останавливается на уже устаревших узлах и стоит столько,
 * сколько узлов стали устаревшими.
 *
 * Подклассы (фигуры) могут переопределить `onWorldInvalidated`, чтобы сбросить свои кэши.
 * Переопределённый `destroy` обязан вызывать `super.destroy()`.
 */
export class Node {
  readonly id: string;
  /** Составная фигура, частью которой является узел, или `null`. */
  readonly owner: Node | null;
  /** Имя для редактора. На отрисовку не влияет. */
  name: string;

  /** Позиция относительно родителя. */
  readonly position: ObservedVec3;
  /**
   * Поворот относительно родителя. Кватернион должен быть единичным: неединичный
   * добавит масштаб. `setRotationFromEuler` всегда даёт единичный.
   */
  readonly rotation: ObservedQuat;
  readonly scale: ObservedVec3;
  /** Точка в локальных координатах, вокруг которой выполняются поворот и масштаб. */
  readonly pivot: ObservedVec3;

  #visible: boolean;
  #opacity: number;
  #appearanceVersion = 0;

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
  }

  // ----- внешний вид ----- //

  get visible(): boolean {
    return this.#visible;
  }
  set visible(value: boolean) {
    if (value !== this.#visible) {
      this.#visible = value;
      this.#appearanceVersion++;
    }
  }

  /** Непрозрачность узла от 0 до 1, умножается на непрозрачность предков. NaN запрещён. */
  get opacity(): number {
    return this.#opacity;
  }
  set opacity(value: number) {
    const opacity = checkOpacity(value);
    if (opacity !== this.#opacity) {
      this.#opacity = opacity;
      this.#appearanceVersion++;
    }
  }

  /** Счётчик изменений внешнего вида самого узла (`visible`, `opacity` и стиль фигур), без учёта предков. */
  get appearanceVersion(): number {
    return this.#appearanceVersion;
  }

  // ----- иерархия ----- //

  get parent(): Node | null {
    return this.#parent;
  }

  /**
   * Дети в порядке отрисовки. Это неизменяемый снимок: он пересоздаётся только при
   * изменении состава детей, поэтому менять дерево во время цикла по нему безопасно.
   */
  get children(): readonly Node[] {
    this.#childrenView ??= Object.freeze(this.#children.slice());
    return this.#childrenView;
  }

  /** Сцена, в которую входит узел, или `null`, если он не подключён к сцене. */
  get scene(): Scene | null {
    return this.#scene;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /**
   * Добавляет `child` в дети на позицию `index` (по умолчанию в конец). Если у него был
   * другой родитель, узел переносится; локальная трансформация сохраняется, поэтому
   * положение в мире может измениться. Узел из другой сцены переносится вместе с id.
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
    // Перестановка внутри того же родителя не меняет мировую матрицу.
    if (oldParent !== this) child.#invalidateWorld();
    if (scene) sceneInternals.touch(scene);
    return this;
  }

  /** Убирает `child` из детей. Ничего не делает, если это не ребёнок этого узла. */
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

  /** Является ли узел предком `node` (не считая самого узла). */
  isAncestorOf(node: Node): boolean {
    for (let current = node.#parent; current; current = current.#parent) {
      if (current === this) return true;
    }
    return false;
  }

  /**
   * Обходит поддерево в глубину, начиная с самого узла. Если `visit` вернёт `false`,
   * обход прекращается и возвращается узел, на котором он остановился; иначе `null`.
   */
  traverse(visit: (node: Node) => boolean | undefined): Node | null {
    if (visit(this) === false) return this;
    for (const child of this.children) {
      const stopped = child.traverse(visit);
      if (stopped) return stopped;
    }
    return null;
  }

  /** Первый узел поддерева (включая сам узел) с указанным `id`. */
  findById(id: string): Node | null {
    return this.traverse((node) => node.id !== id);
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
   * Чтение счётчика сначала пересчитывает устаревшую матрицу.
   */
  get worldVersion(): number {
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
      if (!node.#visible) return false;
    }
    return true;
  }

  /** Непрозрачность с учётом предков. */
  get worldOpacity(): number {
    let opacity = 1;
    for (let node: Node | null = this; node; node = node.#parent) opacity *= node.#opacity;
    return opacity;
  }

  // ----- для подклассов ----- //

  /** Вызывается, когда мировая матрица узла становится устаревшей. */
  protected onWorldInvalidated(): void {}

  /** Для подклассов со своими параметрами внешнего вида (цвет, обводка): увеличивает `appearanceVersion`. */
  protected markAppearanceChanged(): void {
    this.#appearanceVersion++;
  }

  // ----- жизненный цикл ----- //

  /**
   * Отключает узел от родителя и уничтожает всё поддерево. Для корня сцены уничтожает
   * всю сцену. Повторный вызов ничего не делает.
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

  // ----- внутреннее ----- //

  #detachChild(child: Node): void {
    this.#children.splice(this.#children.indexOf(child), 1);
    this.#childrenView = null;
  }

  #invalidateLocal(): void {
    this.#localDirty = true;
    this.#invalidateWorld();
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
    if (this.#destroyed) throw new Error(`Узел «${this.id}» уничтожен.`);
  }

  static {
    nodeInternals = {
      attachRoot(root, scene) {
        root.#assertAlive();
        if (root.#parent || root.#scene) {
          throw new Error(`Узел «${root.id}» уже входит в иерархию и не может быть корнем сцены.`);
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
