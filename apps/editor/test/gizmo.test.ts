import { Camera, Node } from '@mascotte/engine';
import { mat3x4 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import { dragged, gizmoFrame, HANDLE_LENGTH, handleAt, SNAP } from '../src/viewport/gizmo.ts';

const camera = new Camera({ zoom: 2 });
const start = {
  position: { x: 1, y: 2, z: 3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
};
const round = (v: Record<string, number>) =>
  Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Math.round(n * 1e6) / 1e6 + 0]));

describe('gizmo', () => {
  it('shows a node’s axes on screen, and finds the handle under the pointer', () => {
    const node = new Node();
    const frame = gizmoFrame(node, camera, 'world', 1);
    if (!frame) throw new Error('no gizmo');
    const [x, y, z] = frame.axes;
    expect([x.x, x.y, x.pixels]).toEqual([1, 0, 2]);
    expect([y.x, y.y]).toEqual([0, 1]);
    // The z axis points at the viewer: end-on, no move handle.
    expect(z.toward).toBe(true);
    expect(handleAt(frame, 'move', HANDLE_LENGTH - 5, 2)).toEqual({ mode: 'move', axis: 0 });
    expect(handleAt(frame, 'move', 1, HANDLE_LENGTH / 2)).toEqual({ mode: 'move', axis: 1 });
    expect(handleAt(frame, 'move', 40, 40)).toBeNull();
    // The z ring faces the viewer: a circle round the center (the others, edge-on, are lines).
    expect(handleAt(frame, 'rotate', 40, -40)?.axis).toBe(2);
  });

  it('moves along an axis in the parent’s space, snapping to whole units on demand', () => {
    const frame = gizmoFrame(new Node(), camera, 'world', 1);
    if (!frame) throw new Error('no gizmo');
    const parent = mat3x4.create();
    // 21 pixels at zoom 2 along x: 10.5 units, 11 snapped.
    const move = (snap: boolean) =>
      dragged(
        { mode: 'move', axis: 0 },
        frame,
        'world',
        start,
        parent,
        { x: 0, y: 0 },
        { x: 21, y: 7 },
        snap,
      );
    expect(move(false)).toEqual({ name: 'position', value: { x: 11.5, y: 2, z: 3 } });
    expect(move(true).value).toEqual({ x: 12, y: 2, z: 3 });
    // A parent twice as large: half the units in its space.
    mat3x4.compose(parent, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, { x: 2, y: 2, z: 2 });
    const scaled = dragged(
      { mode: 'move', axis: 0 },
      frame,
      'world',
      start,
      parent,
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      false,
    );
    expect(scaled.value).toEqual({ x: 6, y: 2, z: 3 });
  });

  it('turns about an axis by the angle swept on screen, snapping to 15°, and scales along one', () => {
    const frame = gizmoFrame(new Node(), camera, 'local', 1);
    if (!frame) throw new Error('no gizmo');
    const parent = mat3x4.create();
    // A quarter turn clockwise on screen about z, which points at the viewer.
    const turned = dragged(
      { mode: 'rotate', axis: 2 },
      frame,
      'local',
      start,
      parent,
      { x: 50, y: 0 },
      { x: 0, y: 50 },
      false,
    );
    const half = Math.SQRT1_2;
    expect(turned.name).toBe('rotation');
    expect(round(turned.value as never)).toEqual(round({ x: 0, y: 0, z: half, w: half }));
    const snapped = dragged(
      { mode: 'rotate', axis: 2 },
      frame,
      'local',
      start,
      parent,
      { x: 50, y: 0 },
      { x: 50, y: 5 },
      true,
    );
    expect(round(snapped.value as never)).toEqual(round({ x: 0, y: 0, z: 0, w: 1 }));
    expect(SNAP.rotate).toBeCloseTo(Math.PI / 12);
    const grown = dragged(
      { mode: 'scale', axis: 0 },
      frame,
      'local',
      start,
      parent,
      { x: 0, y: 0 },
      { x: HANDLE_LENGTH, y: 0 },
      false,
    );
    expect(grown).toEqual({ name: 'scale', value: { x: 2, y: 1, z: 1 } });
  });
});
