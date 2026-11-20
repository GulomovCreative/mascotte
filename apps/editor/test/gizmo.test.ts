import { Camera, Node } from '@mascotte/engine';
import { type Mat3x4, mat3x4, type Quat, quat } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  dragged,
  type GizmoFrame,
  gizmoFrame,
  HANDLE_LENGTH,
  handleAt,
  type Transform,
  transformOf,
} from '../src/viewport/gizmo.ts';

const camera = new Camera({ zoom: 2 });
const start: Transform = {
  position: { x: 1, y: 2, z: 3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
};
const identity = mat3x4.create();
const round = (v: object) =>
  Object.fromEntries(
    Object.entries(v).map(([k, n]) => [k, Math.round((n as number) * 1e6) / 1e6 + 0]),
  );
const frameOf = (node: Node, space: 'local' | 'world'): GizmoFrame => {
  const frame = gizmoFrame(node, camera, space, 1);
  if (!frame) throw new Error('no gizmo');
  return frame;
};
const inverse = (m: Mat3x4) => mat3x4.invert(mat3x4.create(), m) ?? identity;
/** The same rotation, as a quaternion with w ≥ 0. */
const canonical = (q: Quat) => round(q.w < 0 ? { x: -q.x, y: -q.y, z: -q.z, w: -q.w } : q);

describe('gizmo', () => {
  it('shows a node’s axes on screen, and finds the handle under the pointer', () => {
    const frame = frameOf(new Node(), 'world');
    const [x, y, z] = frame.axes;
    expect([x.x, x.y, x.pixels]).toEqual([1, 0, 2]);
    expect([y.x, y.y]).toEqual([0, 1]);
    // The z axis points at the viewer, end-on: no move handle.
    expect(z.toward).toBe(true);
    expect(handleAt(frame, 'move', 0, 0)?.axis).not.toBe(2);
    expect(handleAt(frame, 'move', HANDLE_LENGTH - 5, 2)).toEqual({ mode: 'move', axis: 0 });
    expect(handleAt(frame, 'move', 1, HANDLE_LENGTH / 2)).toEqual({ mode: 'move', axis: 1 });
    expect(handleAt(frame, 'move', 40, 40)).toBeNull();
    expect(handleAt(frame, 'scale', HANDLE_LENGTH + 4, 3)).toEqual({ mode: 'scale', axis: 0 });
    // The z ring faces the viewer: a circle round the center (the others, edge-on, are lines).
    expect(handleAt(frame, 'rotate', 40, -40)?.axis).toBe(2);
  });

  it('moves along an axis in the parent’s space, snapping to whole units on demand', () => {
    const frame = frameOf(new Node(), 'world');
    // 21 pixels at zoom 2 along x: 10.5 units, 11 snapped.
    const move = (snap: boolean) =>
      dragged(
        { mode: 'move', axis: 0 },
        frame,
        start,
        identity,
        { x: 0, y: 0 },
        { x: 21, y: 7 },
        snap,
      );
    expect(move(false)).toEqual({ name: 'position', value: { x: 11.5, y: 2, z: 3 } });
    expect(move(true).value).toEqual({ x: 12, y: 2, z: 3 });
    // A parent twice as large: half the units in its space.
    const parent = mat3x4.compose(
      mat3x4.create(),
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 2, y: 2, z: 2 },
    );
    const scaled = dragged(
      { mode: 'move', axis: 0 },
      frame,
      start,
      inverse(parent),
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      false,
    );
    expect(scaled.value).toEqual({ x: 6, y: 2, z: 3 });
  });

  it('moves along a turned node’s own axis', () => {
    // Turned a quarter about z: its x axis is the world's y, down the screen.
    const node = new Node({ rotation: { x: 0, y: 0, z: Math.PI / 2, order: 'XYZ' } });
    const frame = frameOf(node, 'local');
    expect(round({ x: frame.axes[0].x, y: frame.axes[0].y })).toEqual({ x: 0, y: 1 });
    const moved = dragged(
      { mode: 'move', axis: 0 },
      frame,
      start,
      identity,
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      false,
    );
    expect(round(moved.value)).toEqual({ x: 1, y: 12, z: 3 });
  });

  it('turns by the angle swept on screen, the other way for a mirrored node, snapping to 15°', () => {
    const frame = frameOf(new Node(), 'local');
    const quarter = (from: Transform, parentInverse = identity) =>
      dragged(
        { mode: 'rotate', axis: 2 },
        frame,
        from,
        parentInverse,
        { x: 50, y: 0 },
        { x: 0, y: 50 },
        false,
      );
    const half = Math.SQRT1_2;
    // A quarter turn clockwise on screen about z, which points at the viewer.
    expect(canonical(quarter(start).value as Quat)).toEqual(
      round({ x: 0, y: 0, z: half, w: half }),
    );
    // Mirrored along z (its own axis), or under a mirroring parent: the other way, so it still
    // follows the pointer on screen.
    const mirrored = { ...start, scale: { x: 1, y: 1, z: -1 } };
    expect(canonical(quarter(mirrored).value as Quat)).toEqual(
      round({ x: 0, y: 0, z: -half, w: half }),
    );
    const mirror = mat3x4.compose(
      mat3x4.create(),
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: -1, y: 1, z: 1 },
    );
    expect(canonical(quarter(start, inverse(mirror)).value as Quat)).toEqual(
      round({ x: 0, y: 0, z: -half, w: half }),
    );
    const snapped = dragged(
      { mode: 'rotate', axis: 2 },
      frame,
      start,
      identity,
      { x: 50, y: 0 },
      { x: 50, y: 5 },
      true,
    );
    expect(canonical(snapped.value as Quat)).toEqual(round({ x: 0, y: 0, z: 0, w: 1 }));
  });

  it('turns about a world axis under a turned parent, the turn being the world’s', () => {
    const parentRotation = quat.setAxisAngle(quat.create(), { x: 0, y: 1, z: 0 }, Math.PI / 2);
    const parent = mat3x4.compose(mat3x4.create(), { x: 0, y: 0, z: 0 }, parentRotation, {
      x: 1,
      y: 1,
      z: 1,
    });
    const own = quat.setAxisAngle(quat.create(), { x: 1, y: 0, z: 0 }, 0.3);
    const from = { ...start, rotation: own };
    const frame = frameOf(new Node(), 'world');
    // About the world's z, which faces the viewer.
    const result = dragged(
      { mode: 'rotate', axis: 2 },
      frame,
      from,
      inverse(parent),
      { x: 50, y: 0 },
      { x: 0, y: 50 },
      false,
    );
    // The world rotation after is the world turn after the world rotation before.
    const worldTurn = quat.setAxisAngle(quat.create(), { x: 0, y: 0, z: 1 }, Math.PI / 2);
    const before = quat.multiply(quat.create(), parentRotation, own);
    const expected = quat.multiply(quat.create(), worldTurn, before);
    const actual = quat.multiply(quat.create(), parentRotation, result.value as Quat);
    expect(canonical(actual)).toEqual(canonical(expected));
  });

  it('scales along an axis, never through zero, and snaps the scale it ends at', () => {
    const frame = frameOf(new Node(), 'local');
    const scale = (from: Transform, to: number, snap = false) =>
      dragged(
        { mode: 'scale', axis: 0 },
        frame,
        from,
        identity,
        { x: 0, y: 0 },
        { x: to, y: 0 },
        snap,
      ).value;
    expect(scale(start, HANDLE_LENGTH)).toEqual({ x: 2, y: 1, z: 1 });
    expect(scale(start, -2 * HANDLE_LENGTH)).toEqual({ x: 0.01, y: 1, z: 1 });
    const flipped = { ...start, scale: { x: -1.5, y: 1, z: 1 } };
    expect(round(scale(flipped, 10, true))).toEqual({ x: -1.7, y: 1, z: 1 });
    expect(scale(flipped, -HANDLE_LENGTH, true)).toEqual({ x: -0.01, y: 1, z: 1 });
  });

  it('reads a transform from the document, filling in from the built node, and none with a reference', () => {
    const node = new Node({ position: { x: 4, y: 5, z: 6 }, scale: { x: 2, y: 2, z: 2 } });
    // What the props leave out comes from the node (a prefab instance's root may set its own).
    expect(transformOf({ position: { x: 1 } }, node)).toEqual({
      position: { x: 1, y: 5, z: 6 },
      scale: { x: 2, y: 2, z: 2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
    expect(transformOf({ position: { param: 'height' } }, node)).toBeNull();
    expect(transformOf({ rotation: { x: 0, y: 0, z: 0, w: { param: 'w' } } }, node)).toBeNull();
  });
});
