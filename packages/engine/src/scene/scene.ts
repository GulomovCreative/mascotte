import { Node } from './node.ts';

/**
 * Сцена: корневой узел, индекс узлов по `id` и кэш плоского списка узлов.
 *
 * Плоский список пересобирается только после изменения структуры дерева (добавления,
 * удаления или перестановки узлов). Изменение трансформаций его не трогает.
 */
export class Scene {
  readonly root: Node;
  readonly #byId = new Map<string, Node>();
  #nodes: Node[] = [];
  #nodesVersion = -1;
  #structureVersion = 0;
  #destroyed = false;

  constructor(root: Node = new Node({ id: 'root' })) {
    this.root = root;
    Node.attachRoot(root, this);
  }

  /** Счётчик изменений структуры. Растёт при каждом добавлении, удалении или перестановке. */
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
    if (this.#destroyed) return this.#nodes;
    if (this.#nodesVersion !== this.#structureVersion) {
      const nodes: Node[] = [];
      this.root.traverse((node) => {
        nodes.push(node);
      });
      this.#nodes = nodes;
      this.#nodesVersion = this.#structureVersion;
    }
    return this.#nodes;
  }

  /** Пересчитывает устаревшие мировые матрицы всех узлов. Актуальные не трогает. */
  updateWorldMatrices(): void {
    for (const node of this.nodes) node.worldMatrix;
  }

  /** Уничтожает корень со всем деревом и очищает индекс. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    Node.detachRoot(this.root);
    this.root.destroy();
    this.#byId.clear();
    this.#nodes = [];
    this.#structureVersion++;
  }

  // ----- для Node ----- //

  /** @internal Сообщает о смене структуры дерева. */
  markStructureChanged(): void {
    this.#structureVersion++;
  }

  /**
   * @internal Регистрирует id поддерева. Сначала проверяет все id и бросает ошибку при
   * конфликте, ничего не изменив.
   */
  attachSubtree(subtree: Node): void {
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

  /** @internal Снимает регистрацию id поддерева. */
  detachSubtree(subtree: Node): void {
    subtree.traverse((node) => {
      if (this.#byId.get(node.id) === node) this.#byId.delete(node.id);
    });
  }
}
