import { quat } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import {
  Animator,
  Camera,
  CLICK_DISTANCE,
  DragRotate,
  Node,
  PointerInputs,
  type PointerInputsSpec,
  Scene,
  Sphere,
} from '../src/index.ts';

const viewport = { width: 100, height: 100 } as const;

/** A 40 wide ball in a `body` group at the frame center, and a small `other` ball at x = 40. */
function setup(spec: Partial<PointerInputsSpec> = {}) {
  const scene = new Scene();
  const body = new Node({ id: 'body' });
  body.add(new Sphere({ id: 'ball', diameter: 40, style: { stroke: 0 } }));
  scene.root.add(body);
  scene.root.add(
    new Sphere({
      id: 'other',
      diameter: 10,
      position: { x: 40, y: 0, z: 0 },
      style: { stroke: 0 },
    }),
  );
  const animator = new Animator(scene);
  const pointer = new PointerInputs(animator, {
    camera: new Camera(),
    viewport,
    target: 'body',
    hover: 'hover',
    press: 'press',
    drag: 'drag',
    click: 'click',
    ...spec,
  });
  return { scene, animator, pointer, inputs: animator.inputs };
}

describe('PointerInputs', () => {
  it('declares its inputs with their types', () => {
    const { inputs } = setup();
    expect(inputs.names).toEqual(['hover', 'press', 'drag', 'click']);
    expect(inputs.typeOf('hover')).toBe('bool');
    expect(inputs.typeOf('click')).toBe('trigger');
  });

  it('hover is tested in update, only over the target, and ends on leave', () => {
    const { pointer, inputs } = setup();
    pointer.move(50, 50);
    expect(inputs.get('hover')).toBe(false);
    pointer.update();
    expect(inputs.get('hover')).toBe(true);
    pointer.move(90, 50); // the other ball, outside the target
    pointer.update();
    expect(pointer.hovering).toBe(false);
    pointer.move(55, 50);
    pointer.update();
    expect(inputs.get('hover')).toBe(true);
    pointer.leave();
    pointer.update();
    expect(inputs.get('hover')).toBe(false);
  });

  it('without a target any shape counts', () => {
    const { pointer } = setup({ target: null });
    pointer.move(90, 50);
    pointer.update();
    expect(pointer.hovering).toBe(true);
  });

  it('a press on the target and a release on it click', () => {
    const { pointer, inputs } = setup();
    pointer.down(50, 50);
    expect(inputs.get('press')).toBe(true);
    pointer.up(52, 50);
    expect(inputs.get('press')).toBe(false);
    expect(inputs.get('click')).toBe(true);
  });

  it('a press off the target does nothing', () => {
    const { pointer, inputs } = setup();
    pointer.down(90, 50);
    expect(inputs.get('press')).toBe(false);
    pointer.up(50, 50);
    expect(inputs.get('click')).toBe(false);
  });

  it('a drag past the click distance is a drag, not a click', () => {
    const { pointer, inputs } = setup();
    pointer.down(50, 50);
    pointer.move(50 + CLICK_DISTANCE, 50);
    expect(inputs.get('drag')).toBe(false);
    pointer.move(50 + CLICK_DISTANCE + 1, 50);
    expect(inputs.get('drag')).toBe(true);
    expect(pointer.dragging).toBe(true);
    pointer.up(50, 50);
    expect(inputs.get('drag')).toBe(false);
    expect(inputs.get('click')).toBe(false);
  });

  it('a release off the target or a leave ends the press without a click', () => {
    const { pointer, inputs } = setup();
    pointer.down(50, 50);
    pointer.up(95, 95);
    expect(inputs.get('click')).toBe(false);
    pointer.down(50, 50);
    pointer.leave();
    expect(inputs.get('press')).toBe(false);
    expect(inputs.get('click')).toBe(false);
  });

  it('the click trigger reaches a state machine', () => {
    const { animator, pointer } = setup();
    animator.addLayer({ name: 'body' });
    const machine = animator.addStateMachine({
      name: 'body',
      layer: 'body',
      inputs: [{ name: 'click', type: 'trigger' }],
      states: [{ name: 'idle' }, { name: 'poked' }],
      initial: 'idle',
      transitions: [{ from: 'idle', to: 'poked', conditions: [{ input: 'click' }] }],
    });
    pointer.down(50, 50);
    pointer.up(50, 50);
    animator.update(0.1);
    expect(machine.state).toBe('poked');
  });

  it('rejects specs without inputs, with shared names or with clashing types, declaring none', () => {
    const animator = new Animator(new Scene());
    const base = { camera: new Camera(), viewport };
    expect(() => new PointerInputs(animator, base)).toThrow(/at least one/);
    expect(() => new PointerInputs(animator, { ...base, hover: 'a', press: 'a' })).toThrow(
      /different inputs/,
    );
    animator.inputs.define({ name: 'taken', type: 'number' });
    expect(() => new PointerInputs(animator, { ...base, hover: 'fresh', click: 'taken' })).toThrow(
      /already a number/,
    );
    expect(animator.inputs.has('fresh')).toBe(false);
  });
});

describe('DragRotate', () => {
  function turned(node: Node) {
    const { x, y, z, w } = node.rotation;
    return { x, y, z, w };
  }

  it('a drag turns the front the way the pointer goes, on top of the rest rotation', () => {
    const rest = quat.setAxisAngle(quat.create(), { x: 0, y: 0, z: 1 }, 0.3);
    const node = new Node();
    node.rotation.set(rest.x, rest.y, rest.z, rest.w);
    const drag = new DragRotate(node, { speed: 0.01 });
    drag.down(10, 10);
    drag.move(60, 10);
    expect(drag.yaw).toBeCloseTo(0.5, 12);
    const expected = quat.multiply(
      quat.create(),
      quat.setAxisAngle(quat.create(), { x: 0, y: 1, z: 0 }, 0.5),
      rest,
    );
    expect(quat.equalsRotation(turned(node), expected, 1e-12)).toBe(true);
    // The front (+z) moves right (+x) and, dragging down, down (+y).
    const front = quat.transformVec3({ x: 0, y: 0, z: 0 }, turned(node), { x: 0, y: 0, z: 1 });
    expect(front.x).toBeGreaterThan(0);
    drag.move(10, 40);
    const down = quat.transformVec3({ x: 0, y: 0, z: 0 }, turned(node), { x: 0, y: 0, z: 1 });
    expect(down.y).toBeGreaterThan(0);
  });

  it('moves only while dragging, continues from where the last drag ended, clamps the pitch', () => {
    const node = new Node();
    const drag = new DragRotate(node, { speed: 0.01, maxPitch: 0.5 });
    drag.move(50, 50);
    expect(drag.yaw).toBe(0);
    drag.down(0, 0);
    drag.up(30, 0);
    drag.move(80, 0);
    expect(drag.yaw).toBeCloseTo(0.3, 12);
    drag.down(0, 0);
    drag.move(20, -200);
    expect(drag.yaw).toBeCloseTo(0.5, 12);
    expect(drag.pitch).toBe(0.5);
  });

  it('settles back to rest after a drag, not during one; reset snaps back', () => {
    const node = new Node();
    const drag = new DragRotate(node, { speed: 0.01, settle: 0.1 });
    drag.down(0, 0);
    drag.move(100, 0);
    drag.update(1);
    expect(drag.yaw).toBeCloseTo(1, 12);
    drag.up(100, 0);
    drag.update(0.1);
    expect(drag.yaw).toBeCloseTo(Math.exp(-1), 12);
    drag.update(5);
    expect(drag.yaw).toBe(0);
    expect(quat.equalsRotation(turned(node), quat.create(), 1e-12)).toBe(true);
    drag.down(0, 0);
    drag.move(50, 50);
    drag.reset();
    expect(drag.dragging).toBe(false);
    expect(turned(node)).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('rejects bad options', () => {
    expect(() => new DragRotate(new Node(), { speed: Number.NaN })).toThrow(/speed/);
    expect(() => new DragRotate(new Node(), { settle: -1 })).toThrow(/settle/);
  });
});
