import { Node, nodeInternals } from './node.ts';

/**
 * Доступ `Node` к закрытому состоянию сцены. Заполняется в статическом блоке `Scene`
 * и не экспортируется из пакета, поэтому внешний код не может испортить индекс.
 */
export let sceneInternals!: {
  /** Регистрирует id поддерева. Сначала проверяет все id и при конфликте бросает ошибку, ничего не изменив. */
  attach(scene: Scene, subtree: Node): void;
  /** Снимает регистрацию id поддерева. */
  detach(scene: Scene, subtree: Node): void;
  /** Сообщает о смене структуры дерева. */
  touch(scene: Scene): void;
};

/**
 * Сцена: корневой узел, индекс узлов по `id` и кэш плоского списка узлов.
 *
 * Плоский список пересобирается только после изменения структуры дерева (добавления,
 * удаления или перестановки узлов). Изменение трансформаций его не трогает.
 */
export class Scene {
  readonly root: Node;
  readonly #byId = new Map<string, Node>();
  #nodes: readonly Node[] = [];
  #nodesVersion = -1;
  #structureVersion = 0;
  #destroyed = false;

  /** Корень можно передать готовым, вместе с детьми: их id тоже регистрируются. */
  constructor(root: Node = new Node()) {
    this.root = root;
    nodeInternals.attachRoot(root, this);
  }

  /** Счётчик изменений структуры. Растёт на 1 при каждом добавлении, удалении или перестановке. */
  get structureVersion(): number {
    return this.#structureVersion;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  getById(id: string): Node | null {
    return this.#byId.get(id) ?? null;
  }

  /** Все узлы сцены в порядке обхода в глубину, начиная с корня. После `destroy` — пустой список. */
  get nodes(): readonly Node[] {
    if (!this.#destroyed && this.#nodesVersion !== this.#structureVersion) {
      const nodes: Node[] = [];
      this.root.traverse((node) => {
        nodes.push(node);
      });
      this.#nodes = Object.freeze(nodes);
      this.#nodesVersion = this.#structureVersion;
    }
    return this.#nodes;
  }

  /** Пересчитывает устаревшие мировые матрицы всех узлов. Актуальные не трогает. */
  updateWorldMatrices(): void {
    for (const node of this.nodes) node.worldMatrix;
  }

  /** Уничтожает корень со всем деревом и очищает индекс. Повторный вызов ничего не делает. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    nodeInternals.detachRoot(this.root);
    this.root.destroy();
    this.#byId.clear();
    this.#nodes = [];
    this.#structureVersion++;
  }

  #attach(subtree: Node): void {
    if (this.#destroyed) throw new Error('Сцена уничтожена.');
    const ids = new Set<string>();
    subtree.traverse((node) => {
      if (this.#byId.has(node.id) || ids.has(node.id)) {
        throw new Error(`В сцене уже есть узел с id «${node.id}».`);
      }
      ids.add(node.id);
    });
    subtree.traverse((node) => {
      this.#byId.set(node.id, node);
    });
  }

  #detach(subtree: Node): void {
    subtree.traverse((node) => {
      if (this.#byId.get(node.id) === node) this.#byId.delete(node.id);
    });
  }

  static {
    sceneInternals = {
      attach: (scene, subtree) => scene.#attach(subtree),
      detach: (scene, subtree) => scene.#detach(subtree),
      touch: (scene) => {
        scene.#structureVersion++;
      },
    };
  }
}
