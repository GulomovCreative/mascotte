import type { Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';

/*
 * Rig: the skeleton of a mascot and its named points. Bones are regular nodes marked with
 * `bone`; the rig lists those of its subtree. Slots are names of rig points (`head`, `eye.L`,
 * `arm.R`) bound to node ids, so animations, behaviors, masks and springs can address a slot
 * instead of a particular node: a motion written for slots fits any mascot that binds its own
 * nodes to them.
 *
 * Wherever a node is targeted, a `Target` is either a node id or `{ slot }`. Slots are
 * resolved through the animator's rig (or the rig passed to `bindClip`) at the moments ids are
 * looked up: when a motion is compiled, a layer mask is set or recomputed, or a spring is
 * added. An id resolves anywhere in the scene, a slot only to a node of the rig's subtree.
 */

/** A reference to a rig slot by name. */
export interface SlotRef {
  readonly slot: string;
}

/** What animations address: a node id, or a rig slot. */
export type Target = string | SlotRef;

/**
 * Slot names: words of letters, digits and `_` joined by dots, starting with a letter
 * (`head`, `eye.L`, `arm_upper.R`).
 */
export const SLOT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

function checkSlotName(name: string): string {
  if (typeof name !== 'string' || !SLOT_NAME_PATTERN.test(name)) {
    throw new RangeError(
      `Slot name "${String(name)}" must be words of letters, digits and _ joined by dots, ` +
        'starting with a letter.',
    );
  }
  return name;
}

function checkSlotId(name: string, id: string): string {
  if (typeof id !== 'string' || id === '') {
    throw new RangeError(`Slot ${name}: the node id must be a non-empty string.`);
  }
  return id;
}

/**
 * The skeleton and named slots of one mascot's subtree. Slots are bound by node id and looked
 * up when resolved, so a node replaced under the same id is found again.
 */
export class Rig {
  /** The mascot's root: slots resolve only to nodes of its subtree (the root included). */
  readonly root: Node;
  readonly #slots = new Map<string, string>();
  #version = 0;

  /** `slots` maps slot names to node ids. Throws a RangeError for an invalid name or id. */
  constructor(root: Node, slots: Readonly<Record<string, string>> = {}) {
    this.root = root;
    for (const [name, id] of Object.entries(slots)) {
      this.#slots.set(checkSlotName(name), checkSlotId(name, id));
    }
  }

  /** Slot names and the node ids they are bound to, in the order they were added. */
  get slots(): ReadonlyMap<string, string> {
    return this.#slots;
  }

  /** Grows by 1 on every change of the slots, so bound targets know to be resolved again. */
  get version(): number {
    return this.#version;
  }

  /** Binds slot `name` to the node with id `id`, replacing an earlier binding. */
  setSlot(name: string, id: string): this {
    checkSlotId(checkSlotName(name), id);
    if (this.#slots.get(name) !== id) {
      this.#slots.set(name, id);
      this.#version++;
    }
    return this;
  }

  /** Removes slot `name`. Returns whether there was one. */
  removeSlot(name: string): boolean {
    const removed = this.#slots.delete(name);
    if (removed) this.#version++;
    return removed;
  }

  /**
   * The node slot `name` is bound to, or `null` when there is no such slot, no node with its
   * id, or that node is not in the root's subtree.
   */
  node(name: string): Node | null {
    const id = this.#slots.get(name);
    if (id === undefined) return null;
    const root = this.root;
    const node = root.scene ? root.scene.getById(id) : root.findById(id);
    if (!node || !(node === root || root.isAncestorOf(node))) return null;
    return node;
  }

  /** The bones of the root's subtree, depth-first, parents before their children. */
  get bones(): Node[] {
    const bones: Node[] = [];
    this.root.traverse((node) => {
      if (node.bone) bones.push(node);
    });
    return bones;
  }
}

/** Where targets are resolved: node ids in `scene`, slots through `rig`. */
export interface TargetScope {
  readonly scene: Scene;
  readonly rig: Rig | null;
}

/** The target for messages: the id itself, or the slot name in brackets (`[eye.L]`). */
export function targetName(target: Target): string {
  if (typeof target === 'object' && target !== null && 'slot' in target) {
    return `[${String(target.slot)}]`;
  }
  return String(target);
}

/**
 * The node `target` addresses in `scope`, or `null`; unlike `lookupTarget` it builds no
 * message, so it can run every frame.
 */
export function resolveTarget(target: Target, scope: TargetScope): Node | null {
  if (typeof target === 'string') return scope.scene.getById(target);
  if (typeof target !== 'object' || target === null || typeof target.slot !== 'string') {
    return null;
  }
  const node = scope.rig?.node(target.slot) ?? null;
  return node && node.scene === scope.scene ? node : null;
}

/**
 * The node `target` addresses in `scope`, or why there is none: an id not in the scene, a
 * slot without a rig, an unknown slot, a slot bound to a node outside the rig or the scene, or
 * a value that is not a target at all.
 */
export function lookupTarget(target: Target, scope: TargetScope): Node | string {
  if (typeof target === 'string') {
    return scope.scene.getById(target) ?? `no node with id "${target}" in the scene.`;
  }
  if (typeof target !== 'object' || target === null || typeof target.slot !== 'string') {
    return 'the target must be a node id or a slot reference { slot }.';
  }
  const name = target.slot;
  const rig = scope.rig;
  if (!rig) return `slot "${name}" needs a rig.`;
  const id = rig.slots.get(name);
  if (id === undefined) return `the rig has no slot "${name}".`;
  const node = rig.node(name);
  if (!node) return `slot "${name}" is bound to "${id}", which is not a node of the rig.`;
  if (node.scene !== scope.scene) {
    return `slot "${name}" is bound to "${id}", which is not in the scene.`;
  }
  return node;
}
