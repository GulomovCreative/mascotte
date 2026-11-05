import { euler, mat3x4, quat, type Vec3, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import { Node, Scene } from '../src/index.ts';

function expectVec(actual: Readonly<Vec3>, expected: Readonly<Vec3>, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

function worldPosition(node: Node): Vec3 {
  return node.getWorldPosition(vec3.create());
}

describe('Node: construction', () => {
  it('defaults', () => {
    const node = new Node();
    expect(node.id).toMatch(/^~\d+$/);
    expect(new Node().id).not.toBe(node.id);
    expect({ ...vec3.clone(node.position) }).toEqual({ x: 0, y: 0, z: 0 });
    expect(vec3.clone(node.scale)).toEqual({ x: 1, y: 1, z: 1 });
    expect(quat.clone(node.rotation)).toEqual(quat.create());
    expect(mat3x4.equals(node.worldMatrix, mat3x4.create())).toBe(true);
    expect(node.visible).toBe(true);
    expect(node.opacity).toBe(1);
  });

  it('constructor parameters', () => {
    const node = new Node({
      id: 'head',
      name: 'Head',
      position: { x: 1, y: 2, z: 3 },
      rotation: euler.create(0, 0, Math.PI / 2),
      scale: 2,
      pivot: { x: 0, y: 1, z: 0 },
      visible: false,
      opacity: 0.5,
    });
    expect(node.id).toBe('head');
    expect(node.name).toBe('Head');
    expect(vec3.clone(node.scale)).toEqual({ x: 2, y: 2, z: 2 });
    expect(new Node({ scale: { x: 1, y: 2, z: 3 } }).scale.z).toBe(3);
    const back = node.getRotationEuler(euler.create());
    expect(back.z).toBeCloseTo(Math.PI / 2, 12);
    // pivot (0, 1, 0) stays in place under a 90° rotation around Z, then the position offset
    // applies.
    expectVec(node.localToWorld(vec3.create(), { x: 0, y: 1, z: 0 }), { x: 1, y: 3, z: 3 });
  });
});

describe('Node: world matrices', () => {
  function chain() {
    const a = new Node({ position: { x: 10, y: 0, z: 0 }, rotation: euler.create(0, 0.4, 0) });
    const b = new Node({ position: { x: 0, y: 5, z: 0 }, scale: { x: 2, y: 1, z: 1 } });
    const c = new Node({ position: { x: 1, y: 1, z: 1 }, rotation: euler.create(0.3, 0, 0.2) });
    a.add(b);
    b.add(c);
    return { a, b, c };
  }

  it('world = parent.world · local', () => {
    const { a, b, c } = chain();
    const expected = mat3x4.multiply(
      mat3x4.create(),
      mat3x4.multiply(mat3x4.create(), a.localMatrix, b.localMatrix),
      c.localMatrix,
    );
    expect(mat3x4.equals(c.worldMatrix, expected)).toBe(true);
  });

  it('repeated access does not recompute the matrix', () => {
    const { c } = chain();
    const version = c.worldVersion;
    c.worldMatrix;
    c.worldMatrix;
    expect(c.worldVersion).toBe(version);
  });

  it('a parent change recomputes descendants, a descendant change does not touch the parent', () => {
    const { a, b, c } = chain();
    const [va, vb, vc] = [a.worldVersion, b.worldVersion, c.worldVersion];
    a.position.x = 20;
    expect([a.worldVersion, b.worldVersion, c.worldVersion]).toEqual([va + 1, vb + 1, vc + 1]);
    c.rotation.copy(quat.setAxisAngle(quat.create(), { x: 0, y: 1, z: 0 }, 1));
    expect([a.worldVersion, b.worldVersion, c.worldVersion]).toEqual([va + 1, vb + 1, vc + 2]);
  });

  it('writing the same value does not mark the node stale', () => {
    const { c } = chain();
    const version = c.worldVersion;
    const x = c.position.x;
    c.position.x = x;
    c.position.set(c.position.x, c.position.y, c.position.z);
    c.scale.copy(c.scale);
    c.rotation.set(c.rotation.x, c.rotation.y, c.rotation.z, c.rotation.w);
    c.pivot.copy(c.pivot);
    expect(c.worldVersion).toBe(version);
  });

  it('vec3 functions write directly to position and mark the node', () => {
    const node = new Node();
    node.worldMatrix;
    vec3.set(node.position, 4, 5, 6);
    expectVec(worldPosition(node), { x: 4, y: 5, z: 6 });
    vec3.scale(node.position, node.position, 2);
    expectVec(worldPosition(node), { x: 8, y: 10, z: 12 });
  });

  it('localToWorld and worldToLocal are inverses, a degenerate matrix gives null', () => {
    const { c } = chain();
    const point = { x: 3, y: -2, z: 7 };
    const world = c.localToWorld(vec3.create(), point);
    const back = c.worldToLocal(vec3.create(), world);
    if (!back) throw new Error('the matrix must be invertible');
    expectVec(back, point);
    c.scale.set(0, 1, 1);
    expect(c.worldToLocal(vec3.create(), world)).toBeNull();
  });

  it('setRotationFromEuler and getRotationEuler', () => {
    const node = new Node();
    node.setRotationFromEuler(euler.create(0.1, 0.2, 0.3, 'ZYX'));
    const back = node.getRotationEuler(euler.create(0, 0, 0, 'ZYX'));
    expect(back.x).toBeCloseTo(0.1, 12);
    expect(back.y).toBeCloseTo(0.2, 12);
    expect(back.z).toBeCloseTo(0.3, 12);
  });

  it('visibleInTree and worldOpacity include ancestors', () => {
    const { a, b, c } = chain();
    a.opacity = 0.5;
    b.opacity = 0.5;
    expect(c.worldOpacity).toBe(0.25);
    expect(c.visibleInTree).toBe(true);
    b.visible = false;
    expect(c.visibleInTree).toBe(false);
    expect(a.visibleInTree).toBe(true);
  });
});

describe('Node: hierarchy', () => {
  it('add at index, reordering within the parent', () => {
    const parent = new Node();
    const [x, y, z] = [new Node(), new Node(), new Node()];
    parent.add(x).add(y).add(z, 0);
    expect(parent.children).toEqual([z, x, y]);
    parent.add(y, 0);
    expect(parent.children).toEqual([y, z, x]);
    parent.add(y, 3);
    expect(parent.children).toEqual([z, x, y]);
    expect(() => parent.add(new Node(), 5)).toThrow(RangeError);
    expect(() => parent.add(new Node(), -1)).toThrow(RangeError);
  });

  it('reparenting keeps the local transform, the world transform changes', () => {
    const left = new Node({ position: { x: -10, y: 0, z: 0 } });
    const right = new Node({ position: { x: 10, y: 0, z: 0 } });
    const child = new Node({ position: { x: 1, y: 0, z: 0 } });
    left.add(child);
    expectVec(worldPosition(child), { x: -9, y: 0, z: 0 });
    right.add(child);
    expect(left.children).toEqual([]);
    expect(child.parent).toBe(right);
    expectVec(worldPosition(child), { x: 11, y: 0, z: 0 });
    child.removeFromParent();
    expect(child.parent).toBeNull();
    expectVec(worldPosition(child), { x: 1, y: 0, z: 0 });
  });

  it('cycles are forbidden', () => {
    const a = new Node();
    const b = new Node();
    a.add(b);
    expect(() => b.add(a)).toThrow(/own descendant/);
    expect(() => a.add(a)).toThrow(/own descendant/);
  });

  it('remove of a non-child node does nothing', () => {
    const a = new Node();
    const b = new Node();
    expect(a.remove(b)).toBe(a);
  });

  it('traverse walks depth-first and stops on false, findById', () => {
    const root = new Node({ id: 'r' });
    const a = new Node({ id: 'a' });
    const b = new Node({ id: 'b' });
    const c = new Node({ id: 'c' });
    root.add(a).add(c);
    a.add(b);
    const order: string[] = [];
    root.traverse((node) => {
      order.push(node.id);
    });
    expect(order).toEqual(['r', 'a', 'b', 'c']);
    const partial: string[] = [];
    root.traverse((node) => {
      partial.push(node.id);
      return node.id !== 'a';
    });
    expect(partial).toEqual(['r', 'a']);
    expect(root.findById('b')).toBe(b);
    expect(root.findById('x')).toBeNull();
  });
});

describe('Scene', () => {
  it('id index for subtrees', () => {
    const scene = new Scene();
    const body = new Node({ id: 'body' });
    const head = new Node({ id: 'head' });
    body.add(head);
    scene.root.add(body);
    expect(scene.getById(scene.root.id)).toBe(scene.root);
    expect(scene.getById('head')).toBe(head);
    expect(head.scene).toBe(scene);
    body.removeFromParent();
    expect(scene.getById('head')).toBeNull();
    expect(head.scene).toBeNull();
  });

  it('an id conflict is rejected without hierarchy changes', () => {
    const scene = new Scene();
    scene.root.add(new Node({ id: 'eye' }));
    const other = new Node();
    const duplicate = new Node({ id: 'eye' });
    other.add(duplicate);
    const version = scene.structureVersion;
    expect(() => scene.root.add(duplicate)).toThrow(/eye/);
    expect(duplicate.parent).toBe(other);
    expect(scene.structureVersion).toBe(version);
    const twins = new Node({ id: 'twin' });
    twins.add(new Node({ id: 'twin-child' })).add(new Node({ id: 'twin-child' }));
    expect(() => scene.root.add(twins)).toThrow(/twin-child/);
    expect(scene.getById('twin')).toBeNull();
  });

  it('a move within a scene keeps the index, a move between scenes transfers ids', () => {
    const first = new Scene();
    const second = new Scene();
    const a = new Node({ id: 'a' });
    const b = new Node({ id: 'b' });
    first.root.add(a).add(b);
    b.add(a);
    expect(first.getById('a')).toBe(a);
    second.root.add(a);
    expect(first.getById('a')).toBeNull();
    expect(second.getById('a')).toBe(a);
    expect(a.scene).toBe(second);
  });

  it('a scene root cannot become a child', () => {
    const scene = new Scene();
    expect(() => new Node().add(scene.root)).toThrow(/is a scene root and cannot become a child/);
    const used = new Node();
    new Node().add(used);
    expect(() => new Scene(used)).toThrow(/cannot be a scene root/);
  });

  it('the flat list is cached until the structure changes', () => {
    const scene = new Scene(new Node({ id: 'root' }));
    const a = new Node({ id: 'a' });
    scene.root.add(a);
    const nodes = scene.nodes;
    expect(nodes.map((node) => node.id)).toEqual(['root', 'a']);
    a.position.x = 5;
    expect(scene.nodes).toBe(nodes);
    a.add(new Node({ id: 'b' }));
    expect(scene.nodes).not.toBe(nodes);
    expect(scene.nodes.map((node) => node.id)).toEqual(['root', 'a', 'b']);
    const reordered = scene.nodes;
    scene.root.add(new Node({ id: 'c' }), 0);
    expect(scene.nodes.map((node) => node.id)).toEqual(['root', 'c', 'a', 'b']);
    expect(scene.nodes).not.toBe(reordered);
  });

  it('updateWorldMatrices recomputes only stale nodes', () => {
    const scene = new Scene();
    const a = new Node();
    const b = new Node();
    scene.root.add(a).add(b);
    scene.updateWorldMatrices();
    const [va, vb] = [a.worldVersion, b.worldVersion];
    b.position.y = 3;
    scene.updateWorldMatrices();
    expect(a.worldVersion).toBe(va);
    expect(b.worldVersion).toBe(vb + 1);
  });
});

describe('destruction', () => {
  it('destroy detaches the subtree and unregisters ids', () => {
    const scene = new Scene();
    const body = new Node({ id: 'body' });
    const head = new Node({ id: 'head' });
    body.add(head);
    scene.root.add(body);
    body.destroy();
    expect(body.destroyed).toBe(true);
    expect(head.destroyed).toBe(true);
    expect(scene.root.children).toEqual([]);
    expect(scene.getById('head')).toBeNull();
    expect(() => scene.root.add(body)).toThrow(/destroyed/);
    expect(() => body.add(new Node())).toThrow(/destroyed/);
    expect(() => body.destroy()).not.toThrow();
  });

  it('Scene.destroy destroys the tree', () => {
    const scene = new Scene();
    const node = new Node({ id: 'x' });
    scene.root.add(node);
    scene.destroy();
    expect(scene.destroyed).toBe(true);
    expect(node.destroyed).toBe(true);
    expect(scene.getById('x')).toBeNull();
    expect(scene.nodes).toEqual([]);
    expect(() => scene.destroy()).not.toThrow();
  });
});
