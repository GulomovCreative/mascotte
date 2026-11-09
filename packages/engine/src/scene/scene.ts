import { Node, nodeInternals } from './node.ts';

/**
 * `Node` access to the scene's private state. Filled in the static block of `Scene`
 * and not exported from the package, so outside code cannot corrupt the index.
 */
export let sceneInternals!: {
  /**
   * Registers the ids of a subtree. First checks all ids and throws on a conflict without changing
   * anything.
   */
  attach(scene: Scene, subtree: Node): void;
  /** Unregisters the ids of a subtree. */
  detach(scene: Scene, subtree: Node): void;
  /** Reports a change in the tree structure. */
  touch(scene: Scene): void;
  /** Reports any change of a scene node. */
  changed(scene: Scene): void;
};

/**
 * Scene: the root node, an index of nodes by `id` and a cached flat list of nodes.
 *
 * The flat list is rebuilt only after the tree structure changes (adding,
 * removing or reordering nodes). Transform changes do not touch it.
 */
export class Scene {
  readonly root: Node;
  readonly #byId = new Map<string, Node>();
  #nodes: readonly Node[] = [];
  #nodesVersion = -1;
  #structureVersion = 0;
  #changeVersion = 0;
  #destroyed = false;

  /** The root can be passed ready-made, with children: their ids are registered too. */
  constructor(root: Node = new Node()) {
    this.root = root;
    nodeInternals.attachRoot(root, this);
  }

  /** Structure change counter. Grows by 1 on every add, remove or reorder. */
  get structureVersion(): number {
    return this.#structureVersion;
  }

  /**
   * Counter of any scene change: structure, transforms, visibility, opacity,
   * style, shape geometry and parameters, sort mode, layer, `zBias` and the `bone` flag. If it,
   * the camera and the frame size have not changed, the frame is the same and need not be rebuilt.
   */
  get changeVersion(): number {
    return this.#changeVersion;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  getById(id: string): Node | null {
    return this.#byId.get(id) ?? null;
  }

  /**
   * All scene nodes in depth-first order, starting from the root. After `destroy`, an empty list.
   */
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

  /** Recomputes stale world matrices of all nodes. Leaves up-to-date ones alone. */
  updateWorldMatrices(): void {
    for (const node of this.nodes) node.worldMatrix;
  }

  /** Destroys the root with the whole tree and clears the index. A repeated call does nothing. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    nodeInternals.detachRoot(this.root);
    this.root.destroy();
    this.#byId.clear();
    this.#nodes = [];
    this.#structureVersion++;
    this.#changeVersion++;
  }

  #attach(subtree: Node): void {
    if (this.#destroyed) throw new Error('Scene is destroyed.');
    const ids = new Set<string>();
    subtree.traverse((node) => {
      if (this.#byId.has(node.id) || ids.has(node.id)) {
        throw new Error(`The scene already has a node with id "${node.id}".`);
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
        scene.#changeVersion++;
      },
      changed: (scene) => {
        scene.#changeVersion++;
      },
    };
  }
}
