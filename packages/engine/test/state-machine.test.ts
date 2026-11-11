import { describe, expect, it } from 'vitest';
import {
  type AnimationLayer,
  Animator,
  type BehaviorSet,
  type Blend1D,
  type Clip,
  type ConditionOp,
  type InputSpec,
  Inputs,
  Node,
  PathShape,
  Scene,
  type StateMachineSpec,
  type StateSpec,
} from '../src/index.ts';

/** A clip holding `property` of `target` at `value` for `duration` seconds. */
function hold(
  target: string,
  property: string,
  value: unknown,
  duration = 1,
  loop: Clip['loop'] = 'once',
): Clip {
  return { duration, loop, tracks: [{ target, property, keys: [{ time: 0, value }] }] };
}

/** `property` of `target` from `from` to `to` over `duration` seconds. */
function ramp(
  target: string,
  property: string,
  from: unknown,
  to: unknown,
  duration = 1,
  loop: Clip['loop'] = 'once',
): Clip {
  return {
    duration,
    loop,
    tracks: [
      {
        target,
        property,
        keys: [
          { time: 0, value: from },
          { time: duration, value: to },
        ],
      },
    ],
  };
}

function setup() {
  const scene = new Scene();
  const body = new Node({ id: 'body' });
  const face = new PathShape({ id: 'face' });
  body.add(face);
  scene.root.add(body);
  const animator = new Animator(scene);
  animator.addLayer({ name: 'body' });
  animator.addLayer({ name: 'face' });
  return { scene, body, face, animator };
}

function layerOf(animator: Animator, name: string): AnimationLayer {
  const layer = animator.layer(name);
  if (!layer) throw new Error(`No layer ${name}.`);
  return layer;
}

const idle = hold('body', 'opacity', 0.5);
const happy = hold('body', 'opacity', 1);

describe('Inputs', () => {
  it('declares bool, number and trigger inputs with their starting values', () => {
    const inputs = new Inputs();
    inputs.define({ name: 'hover', type: 'bool' });
    inputs.define({ name: 'mood', type: 'number', value: 0.5 });
    inputs.define({ name: 'poke', type: 'trigger' });
    expect(inputs.names).toEqual(['hover', 'mood', 'poke']);
    expect(inputs.get('hover')).toBe(false);
    expect(inputs.get('mood')).toBe(0.5);
    expect(inputs.get('poke')).toBe(false);
    expect(inputs.typeOf('mood')).toBe('number');
    expect(inputs.has('nothing')).toBe(false);
    inputs.set('hover', true);
    inputs.set('mood', -2);
    inputs.fire('poke');
    expect(inputs.get('hover')).toBe(true);
    expect(inputs.get('mood')).toBe(-2);
    expect(inputs.get('poke')).toBe(true);
  });

  it('keeps the value when an input is declared again with the same type', () => {
    const inputs = new Inputs();
    inputs.define({ name: 'mood', type: 'number' });
    inputs.set('mood', 3);
    inputs.define({ name: 'mood', type: 'number' });
    inputs.define({ name: 'mood', type: 'number', value: 0 });
    expect(inputs.get('mood')).toBe(3);
    expect(() => inputs.define({ name: 'mood', type: 'bool' })).toThrow(/already a number/);
    expect(() => inputs.define({ name: 'mood', type: 'number', value: 1 })).toThrow(
      /already declared starting at 0, not 1/,
    );
  });

  it('rejects bad declarations and values with messages naming the input', () => {
    const inputs = new Inputs();
    expect(() => inputs.define({ name: '1st', type: 'bool' })).toThrow(/Input name "1st"/);
    expect(() => inputs.define({ name: 'a', type: 'text' as 'bool' })).toThrow(/type must be/);
    expect(() =>
      inputs.define({ name: 'a', type: 'bool', value: 1 } as unknown as InputSpec),
    ).toThrow(/is a bool/);
    expect(() =>
      inputs.define({ name: 'a', type: 'trigger', value: true } as unknown as InputSpec),
    ).toThrow(/no value/);
    expect(() =>
      inputs.define({ name: 'a', type: 'bool', extra: 1 } as unknown as {
        name: string;
        type: 'bool';
      }),
    ).toThrow(/unknown option "extra"/);
    inputs.define({ name: 'mood', type: 'number' });
    inputs.define({ name: 'poke', type: 'trigger' });
    expect(() => inputs.set('mood', Number.NaN)).toThrow(/finite/);
    expect(() => inputs.set('mood', true)).toThrow(/is a number/);
    expect(() => inputs.set('poke', true)).toThrow(/trigger/);
    expect(() => inputs.fire('mood')).toThrow(/not a trigger/);
    expect(() => inputs.get('missing')).toThrow(/No input "missing" \(inputs: mood, poke\)/);
  });

  it('a trigger holds until the next animator update and is cleared after it', () => {
    const { animator } = setup();
    animator.inputs.define({ name: 'poke', type: 'trigger' });
    animator.inputs.fire('poke');
    animator.inputs.fire('poke');
    expect(animator.inputs.get('poke')).toBe(true);
    animator.evaluate();
    expect(animator.inputs.get('poke')).toBe(true);
    animator.update(0.016);
    expect(animator.inputs.get('poke')).toBe(false);
  });
});

describe('Blend 1D', () => {
  function blendSetup() {
    const { body, face, animator } = setup();
    animator.inputs.define({ name: 'mood', type: 'number' });
    const blend: Blend1D = {
      input: 'mood',
      blend: [
        { at: -1, motion: hold('body', 'opacity', 0) },
        { at: 0, motion: hold('body', 'opacity', 0.5) },
        { at: 2, motion: hold('face', 'opacity', 0.2) },
      ],
    };
    return { body, face, animator, blend, layer: layerOf(animator, 'body') };
  }

  it('mixes the two neighbors by where the input is between their points', () => {
    const { body, face, animator, blend, layer } = blendSetup();
    layer.play(blend);
    animator.inputs.set('mood', -0.5);
    animator.evaluate();
    expect(body.opacity).toBeCloseTo(0.25);
    expect(face.opacity).toBe(1);
    animator.inputs.set('mood', 1);
    animator.evaluate();
    // Half way to the last point: body goes towards its rest (1), face towards 0.2.
    expect(body.opacity).toBeCloseTo(0.75);
    expect(face.opacity).toBeCloseTo(0.6);
  });

  it('holds the end motions outside the points, with rest for channels they do not animate', () => {
    const { body, face, animator, blend, layer } = blendSetup();
    body.opacity = 0.9;
    layer.play(blend);
    animator.inputs.set('mood', -5);
    animator.evaluate();
    expect(body.opacity).toBeCloseTo(0);
    expect(face.opacity).toBe(1);
    animator.inputs.set('mood', 5);
    animator.evaluate();
    expect(body.opacity).toBeCloseTo(0.9);
    expect(face.opacity).toBeCloseTo(0.2);
  });

  it('changes continuously as the input crosses a point', () => {
    const { body, animator, blend, layer } = blendSetup();
    layer.play(blend);
    let previous = Number.NaN;
    for (let mood = -1.2; mood <= 2.2; mood += 0.05) {
      animator.inputs.set('mood', mood);
      animator.evaluate();
      if (!Number.isNaN(previous)) expect(Math.abs(body.opacity - previous)).toBeLessThan(0.05);
      previous = body.opacity;
    }
  });

  it('samples every motion at the layer time, each with its own loop mode', () => {
    const { body, animator } = setup();
    animator.inputs.define({ name: 'speed', type: 'number', value: 0.5 });
    const layer = layerOf(animator, 'body');
    layer.play({
      input: 'speed',
      blend: [
        { at: 0, motion: ramp('body', 'opacity', 0, 1, 1) },
        { at: 1, motion: ramp('body', 'opacity', 0, 1, 2) },
      ],
    });
    animator.update(0.5);
    // 0.5 and 0.25 of the way, mixed half and half.
    expect(body.opacity).toBeCloseTo(0.375);
  });

  it('blends behaviors too', () => {
    const { body, animator } = setup();
    animator.inputs.define({ name: 'k', type: 'number', value: 0.5 });
    const still: BehaviorSet = {
      behaviors: [
        {
          kind: 'oscillate',
          target: 'body',
          property: 'opacity',
          from: 0,
          to: 0,
          period: 1,
        },
      ],
    };
    layerOf(animator, 'body').play({
      input: 'k',
      blend: [
        { at: 0, motion: still },
        { at: 1, motion: happy },
      ],
    });
    animator.evaluate();
    expect(body.opacity).toBeCloseTo(0.5);
  });

  it('rejects a bad blend with a message', () => {
    const { animator } = setup();
    const layer = layerOf(animator, 'body');
    animator.inputs.define({ name: 'on', type: 'bool' });
    animator.inputs.define({ name: 'k', type: 'number' });
    expect(() => layer.play({ input: 'nope', blend: [{ at: 0, motion: idle }] })).toThrow(
      /no input "nope"/,
    );
    expect(() => layer.play({ input: 'on', blend: [{ at: 0, motion: idle }] })).toThrow(
      /is a bool, a blend needs a number/,
    );
    expect(() => layer.play({ input: 'k', blend: [] })).toThrow(/non-empty/);
    expect(() =>
      layer.play({
        input: 'k',
        blend: [
          { at: 1, motion: idle },
          { at: 1, motion: happy },
        ],
      }),
    ).toThrow(/increasing order/);
    expect(() =>
      layer.play({
        input: 'k',
        blend: [{ at: 0, motion: { input: 'k', blend: [] } as unknown as Clip }],
      }),
    ).toThrow(/do not nest/);
    expect(() => layer.play({ input: 'k', blend: [{ at: Number.NaN, motion: idle }] })).toThrow(
      /finite at/,
    );
  });
});

describe('StateMachine', () => {
  function moodMachine(extra: Partial<StateMachineSpec> = {}): StateMachineSpec {
    return {
      name: 'mood',
      layer: 'body',
      inputs: [
        { name: 'happy', type: 'bool' },
        { name: 'poke', type: 'trigger' },
      ],
      states: [
        { name: 'idle', motion: idle },
        { name: 'happy', motion: happy },
      ],
      transitions: [
        { from: 'idle', to: 'happy', conditions: [{ input: 'happy' }], duration: 0.5 },
        { from: 'happy', to: 'idle', conditions: [{ input: 'happy', value: false }] },
      ],
      ...extra,
    };
  }

  it('enters its initial state at once and moves on when a condition holds, fading in', () => {
    const { body, animator } = setup();
    const machine = animator.addStateMachine(moodMachine());
    expect(animator.stateMachines).toEqual([machine]);
    expect(machine.state).toBe('idle');
    expect(machine.states).toEqual(['idle', 'happy']);
    expect(machine.layer).toBe(animator.layer('body'));
    animator.update(0);
    expect(body.opacity).toBeCloseTo(0.5);
    animator.inputs.set('happy', true);
    animator.update(0.1);
    expect(machine.state).toBe('happy');
    expect(machine.time).toBe(0);
    animator.update(0.25);
    expect(body.opacity).toBeCloseTo(0.75);
    animator.update(0.25);
    expect(body.opacity).toBeCloseTo(1);
    animator.inputs.set('happy', false);
    animator.update(0.1);
    expect(machine.state).toBe('idle');
    expect(body.opacity).toBeCloseTo(0.5);
  });

  it('starts in the named initial state', () => {
    const { animator } = setup();
    expect(animator.addStateMachine(moodMachine({ initial: 'happy' })).state).toBe('happy');
  });

  it('a trigger fires a transition in the next update only', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine(
      moodMachine({
        transitions: [
          { from: 'idle', to: 'happy', conditions: [{ input: 'poke' }] },
          { from: 'happy', to: 'idle', conditions: [{ input: 'poke' }] },
        ],
      }),
    );
    animator.inputs.fire('poke');
    animator.update(0.1);
    expect(machine.state).toBe('happy');
    // At most one transition per update, and the trigger is gone after it.
    animator.update(0.1);
    expect(machine.state).toBe('happy');
    animator.inputs.fire('poke');
    animator.update(0.1);
    expect(machine.state).toBe('idle');
  });

  it('several machines see the same trigger in the same update', () => {
    const { animator } = setup();
    const body = animator.addStateMachine(
      moodMachine({
        transitions: [{ from: 'idle', to: 'happy', conditions: [{ input: 'poke' }] }],
      }),
    );
    const face = animator.addStateMachine({
      layer: 'face',
      inputs: [{ name: 'poke', type: 'trigger' }],
      states: [
        { name: 'calm', motion: hold('face', 'opacity', 0.5) },
        { name: 'surprised', motion: hold('face', 'opacity', 1) },
      ],
      transitions: [{ from: 'calm', to: 'surprised', conditions: [{ input: 'poke' }] }],
    });
    animator.inputs.fire('poke');
    animator.update(0.1);
    expect(body.state).toBe('happy');
    expect(face.state).toBe('surprised');
  });

  it('compares number inputs and needs every condition of a transition', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      inputs: [
        { name: 'level', type: 'number' },
        { name: 'on', type: 'bool', value: true },
      ],
      states: [
        { name: 'low', motion: idle },
        { name: 'high', motion: happy },
      ],
      transitions: [
        {
          from: 'low',
          to: 'high',
          conditions: [
            { input: 'level', op: '>=', value: 2 },
            { input: 'on', op: '!=', value: false },
          ],
        },
        { from: 'high', to: 'low', conditions: [{ input: 'level', op: '<', value: 1 }] },
      ],
    });
    animator.inputs.set('level', 1.5);
    animator.update(0.1);
    expect(machine.state).toBe('low');
    animator.inputs.set('level', 2);
    animator.inputs.set('on', false);
    animator.update(0.1);
    expect(machine.state).toBe('low');
    animator.inputs.set('on', true);
    animator.update(0.1);
    expect(machine.state).toBe('high');
    animator.inputs.set('level', 1);
    animator.update(0.1);
    expect(machine.state).toBe('high');
    animator.inputs.set('level', 0.5);
    animator.update(0.1);
    expect(machine.state).toBe('low');
  });

  it('checks transitions from any state first, but not into the current state', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      inputs: [{ name: 'reset', type: 'bool' }],
      states: [
        { name: 'idle', motion: idle },
        { name: 'busy', motion: happy },
      ],
      transitions: [
        { from: 'idle', to: 'busy', conditions: [{ input: 'reset' }] },
        { from: '*', to: 'idle', conditions: [{ input: 'reset' }] },
      ],
    });
    animator.inputs.set('reset', true);
    // From idle, the any-state transition into idle is skipped, so idle → busy fires.
    animator.update(0.1);
    expect(machine.state).toBe('busy');
    // From busy, the any-state transition comes first.
    animator.update(0.1);
    expect(machine.state).toBe('idle');
  });

  it('waits for a clip played once to reach its exit time, then starts the next state by the overshoot', () => {
    const { body, animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      states: [
        { name: 'hop', motion: hold('body', 'opacity', 0.2, 1) },
        { name: 'rest', motion: ramp('body', 'opacity', 0, 1, 1) },
      ],
      transitions: [{ from: 'hop', to: 'rest', exitTime: 1 }],
    });
    animator.update(0.6);
    expect(machine.state).toBe('hop');
    animator.update(0.6);
    expect(machine.state).toBe('rest');
    expect(machine.time).toBeCloseTo(0.2);
    expect(body.opacity).toBeCloseTo(0.2);
  });

  it('a clip played once may leave at its exit time or any time after, when the conditions hold', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      inputs: [{ name: 'go', type: 'bool' }],
      states: [
        { name: 'a', motion: hold('body', 'opacity', 0.2, 1) },
        { name: 'b', motion: idle },
      ],
      transitions: [{ from: 'a', to: 'b', exitTime: 0.5, conditions: [{ input: 'go' }] }],
    });
    animator.update(2);
    expect(machine.state).toBe('a');
    animator.inputs.set('go', true);
    animator.update(0.1);
    expect(machine.state).toBe('b');
    // Long past the exit point: the new state starts at most a frame in.
    expect(machine.time).toBeCloseTo(0.1);
  });

  it('a looping clip leaves only when it passes the exit point of a cycle', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      inputs: [{ name: 'go', type: 'bool' }],
      states: [
        { name: 'walk', motion: hold('body', 'opacity', 0.2, 1, 'loop') },
        { name: 'stop', motion: idle },
      ],
      transitions: [{ from: 'walk', to: 'stop', exitTime: 0.5, conditions: [{ input: 'go' }] }],
    });
    // The exit point at 1.5 passes while the condition does not hold.
    animator.update(1.6);
    animator.inputs.set('go', true);
    animator.update(0.2);
    expect(machine.state).toBe('walk');
    animator.update(0.6);
    expect(machine.state).toBe('walk');
    // 2.4 → 2.6 passes the next cycle's exit point, 2.5.
    animator.update(0.2);
    expect(machine.state).toBe('stop');
    expect(machine.time).toBeCloseTo(0.1);
  });

  it('a ping-pong clip comes to its exit point once per two durations', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      states: [
        { name: 'swing', motion: hold('body', 'opacity', 0.2, 1, 'pingpong') },
        { name: 'still', motion: idle },
      ],
      transitions: [{ from: 'swing', to: 'still', exitTime: 1.5 }],
    });
    animator.update(1.4);
    expect(machine.state).toBe('swing');
    animator.update(0.2);
    expect(machine.state).toBe('still');
  });

  it('a state without a motion stops the layer', () => {
    const { body, animator } = setup();
    body.opacity = 0.8;
    const machine = animator.addStateMachine(
      moodMachine({
        states: [
          { name: 'idle', motion: null },
          { name: 'happy', motion: happy },
        ],
      }),
    );
    animator.update(0);
    expect(body.opacity).toBeCloseTo(0.8);
    animator.inputs.set('happy', true);
    animator.update(0.5);
    animator.update(0.5);
    expect(body.opacity).toBeCloseTo(1);
    animator.inputs.set('happy', false);
    animator.update(0);
    expect(machine.state).toBe('idle');
    expect(layerOf(animator, 'body').motion).toBeNull();
    expect(body.opacity).toBeCloseTo(0.8);
  });

  it('a blend state follows its input while the machine is in it', () => {
    const { body, animator } = setup();
    animator.addStateMachine({
      layer: 'body',
      inputs: [{ name: 'mood', type: 'number' }],
      states: [
        {
          name: 'face',
          motion: {
            input: 'mood',
            blend: [
              { at: 0, motion: idle },
              { at: 1, motion: happy },
            ],
          },
        },
      ],
    });
    animator.update(0);
    expect(body.opacity).toBeCloseTo(0.5);
    animator.inputs.set('mood', 0.5);
    animator.update(0);
    expect(body.opacity).toBeCloseTo(0.75);
  });

  it('setState and reset jump to a state whatever the conditions', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine(moodMachine());
    machine.setState('happy', { fade: 0.2 });
    expect(machine.state).toBe('happy');
    expect(layerOf(animator, 'body').fading).toBe(true);
    animator.update(0.3);
    machine.reset();
    expect(machine.state).toBe('idle');
    expect(machine.time).toBe(0);
    expect(() => machine.setState('gone')).toThrow(/no state "gone" \(states: idle, happy\)/);
    expect(() => machine.setState('idle', { fade: -1 })).toThrow(/fade must be/);
  });

  it('a removed machine no longer steps; its layer keeps its motion', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine(moodMachine());
    expect(animator.removeStateMachine(machine)).toBe(true);
    expect(animator.removeStateMachine(machine)).toBe(false);
    animator.inputs.set('happy', true);
    animator.update(0.1);
    expect(machine.state).toBe('idle');
    expect(layerOf(animator, 'body').motion).toBe(idle);
    // The layer is free for another machine.
    expect(() => animator.addStateMachine(moodMachine())).not.toThrow();
  });

  it('toSpec gives a copy of the spec it was made from', () => {
    const { animator } = setup();
    const spec = moodMachine();
    const machine = animator.addStateMachine(spec);
    const copy = machine.toSpec();
    expect(copy).toEqual(spec);
    expect(copy).not.toBe(spec);
    expect(copy.transitions?.[0]?.conditions).not.toBe(spec.transitions?.[0]?.conditions);
    expect(copy.states[0]?.motion).toBe(idle);
  });

  it('rejects bad specs with messages naming the machine and the part', () => {
    const { animator } = setup();
    const bad = (spec: Partial<StateMachineSpec>) => () =>
      animator.addStateMachine({ ...moodMachine(), ...spec } as StateMachineSpec);
    expect(bad({ layer: 'legs' })).toThrow(/no layer "legs"/);
    expect(bad({ states: [] })).toThrow(/State machine "mood": it needs at least one state/);
    expect(bad({ states: [{ name: '*', motion: idle }] })).toThrow(/non-empty string other than/);
    expect(
      bad({
        states: [
          { name: 'a', motion: idle },
          { name: 'a', motion: idle },
        ],
        transitions: [],
      }),
    ).toThrow(/two states are named "a"/);
    expect(bad({ initial: 'nowhere' })).toThrow(/no initial state "nowhere"/);
    expect(bad({ extra: 1 } as Partial<StateMachineSpec>)).toThrow(/unknown option "extra"/);
    expect(bad({ transitions: [{ from: 'idle', to: 'happy' }] })).toThrow(
      /transition 0: it needs a condition or an exitTime/,
    );
    expect(bad({ transitions: [{ from: 'x', to: 'happy', exitTime: 1 }] })).toThrow(
      /no state "x" to leave/,
    );
    expect(bad({ transitions: [{ from: 'idle', to: 'y', exitTime: 1 }] })).toThrow(
      /no state "y" to enter/,
    );
    expect(bad({ transitions: [{ from: '*', to: 'idle', exitTime: 1 }] })).toThrow(
      /exitTime needs a transition from a state that plays a clip/,
    );
    expect(
      bad({
        transitions: [{ from: 'idle', to: 'happy', exitTime: 1, duration: -1 }],
      }),
    ).toThrow(/duration must be a finite non-negative number/);
    const condition = (c: object) =>
      bad({ transitions: [{ from: 'idle', to: 'happy', conditions: [c as { input: string }] }] });
    expect(condition({ input: 'nope' })).toThrow(
      /condition 0: the machine does not declare input "nope" \(its inputs: happy, poke\)/,
    );
    expect(condition({ input: 'poke', value: true })).toThrow(/is a trigger: it takes no op/);
    expect(condition({ input: 'happy', op: '<' })).toThrow(/is a bool: op must be == or !=/);
    expect(condition({ input: 'happy', value: 1 })).toThrow(/value must be a boolean/);
    expect(condition({ input: 'happy', op: '~' })).toThrow(/op must be one of/);
    expect(condition({ input: 'happy', when: 1 })).toThrow(/unknown option "when"/);
  });

  it('rejects number conditions without an op or a value, and motions that do not resolve', () => {
    const { animator } = setup();
    const spec = (conditions: object[]): StateMachineSpec => ({
      layer: 'body',
      inputs: [{ name: 'n', type: 'number' }],
      states: [
        { name: 'a', motion: idle },
        { name: 'b', motion: happy },
      ],
      transitions: [{ from: 'a', to: 'b', conditions: conditions as { input: string }[] }],
    });
    expect(() => animator.addStateMachine(spec([{ input: 'n', value: 1 }]))).toThrow(/needs an op/);
    expect(() => animator.addStateMachine(spec([{ input: 'n', op: '>' }]))).toThrow(
      /finite number/,
    );
    expect(() =>
      animator.addStateMachine({
        layer: 'body',
        states: [{ name: 'lost', motion: hold('nobody', 'opacity', 1) }],
      }),
    ).toThrow(/state "lost": .*nobody/);
    expect(animator.stateMachines).toEqual([]);
  });

  it('a failed add declares no inputs and leaves the layer as it was', () => {
    const { animator } = setup();
    const layer = layerOf(animator, 'body');
    layer.play(idle);
    expect(() =>
      animator.addStateMachine({
        name: 'broken',
        layer: 'body',
        inputs: [{ name: 'mood', type: 'number' }],
        states: [{ name: 'lost', motion: hold('nobody', 'opacity', 1) }],
      }),
    ).toThrow(/State machine "broken": state "lost": .*nobody/);
    expect(animator.inputs.names).toEqual([]);
    expect(layer.motion).toBe(idle);
    // Fixed, with another type for the same input.
    animator.addStateMachine({
      layer: 'body',
      inputs: [{ name: 'mood', type: 'bool' }],
      states: [{ name: 'ok', motion: happy }],
    });
    expect(animator.inputs.typeOf('mood')).toBe('bool');
  });

  it('input errors name the machine and the input, and inputs must be a list', () => {
    const { animator } = setup();
    animator.addStateMachine(moodMachine());
    expect(() =>
      animator.addStateMachine({
        name: 'face',
        layer: 'face',
        inputs: [
          { name: 'calm', type: 'bool' },
          { name: 'poke', type: 'bool' },
        ],
        states: [{ name: 'a', motion: idle }],
      }),
    ).toThrow(/State machine "face": input 1: Input "poke" is already a trigger/);
    expect(animator.inputs.has('calm')).toBe(false);
    const face = (inputs: unknown) => () =>
      animator.addStateMachine({
        name: 'face',
        layer: 'face',
        inputs: inputs as InputSpec[],
        states: [{ name: 'a', motion: idle }],
      });
    expect(face('abc')).toThrow(/State machine "face": inputs must be a list/);
    expect(face([{ name: 'x', type: 'bool', valu: 1 }])).toThrow(
      /"face": input 0: Input "x": unknown option "valu"/,
    );
    expect(
      face([
        { name: 'x', type: 'bool' },
        { name: 'x', type: 'bool' },
      ]),
    ).toThrow(/"x" is declared twice/);
  });

  it('a blend state must read an input the machine declares', () => {
    const { animator } = setup();
    animator.inputs.define({ name: 'mood', type: 'number' });
    expect(() =>
      animator.addStateMachine({
        layer: 'body',
        states: [{ name: 'b', motion: { input: 'mood', blend: [{ at: 0, motion: idle }] } }],
      }),
    ).toThrow(/state "b": its blend reads input "mood", which the machine does not declare/);
  });

  it('a transition whose motion no longer resolves enters its state with the layer stopped', () => {
    const { scene, body, animator } = setup();
    const arm = new Node({ id: 'arm' });
    scene.root.add(arm);
    const machine = animator.addStateMachine({
      layer: 'body',
      inputs: [{ name: 'poke', type: 'trigger' }],
      states: [
        { name: 'a', motion: idle },
        { name: 'b', motion: hold('arm', 'opacity', 0.3) },
      ],
      transitions: [
        { from: 'a', to: 'b', conditions: [{ input: 'poke' }] },
        { from: 'b', to: 'a', conditions: [{ input: 'poke' }] },
      ],
    });
    arm.destroy();
    animator.inputs.fire('poke');
    expect(() => animator.update(0.1)).not.toThrow();
    expect(machine.state).toBe('b');
    expect(machine.problem).toMatch(/arm/);
    expect(animator.inputs.get('poke')).toBe(false);
    expect(layerOf(animator, 'body').motion).toBeNull();
    expect(body.opacity).toBe(1);
    // It leaves again normally.
    animator.inputs.fire('poke');
    animator.update(0.1);
    expect(machine.state).toBe('a');
    expect(machine.problem).toBeNull();
    expect(body.opacity).toBeCloseTo(0.5);
  });

  it('a removed machine cannot be driven any more', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine(moodMachine());
    animator.removeStateMachine(machine);
    expect(() => machine.setState('happy')).toThrow(/removed from its animator/);
    expect(() => machine.reset()).toThrow(/removed from its animator/);
  });

  it('rejects a transition into its own state that would restart it every update', () => {
    const { animator } = setup();
    const self = (conditions: { input: string }[], exitTime?: number) => () =>
      animator.addStateMachine(
        moodMachine({
          transitions: [
            { from: 'idle', to: 'idle', conditions, ...(exitTime ? { exitTime } : {}) },
          ],
        }),
      );
    expect(self([{ input: 'happy' }])).toThrow(/into its own state needs a trigger or an exitTime/);
    expect(self([{ input: 'poke' }])).not.toThrow();
  });

  it('a trigger is lost while its transition waits for an exit time', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      inputs: [{ name: 'poke', type: 'trigger' }],
      states: [
        { name: 'a', motion: hold('body', 'opacity', 0.2, 1) },
        { name: 'b', motion: idle },
      ],
      transitions: [{ from: 'a', to: 'b', exitTime: 1, conditions: [{ input: 'poke' }] }],
    });
    animator.inputs.fire('poke');
    animator.update(0.3);
    animator.update(1);
    expect(machine.state).toBe('a');
  });

  it('compares numbers with every operator', () => {
    const cases: [ConditionOp, number, boolean][] = [];
    const truth: Record<ConditionOp, (a: number, b: number) => boolean> = {
      '==': (a, b) => a === b,
      '!=': (a, b) => a !== b,
      '<': (a, b) => a < b,
      '<=': (a, b) => a <= b,
      '>': (a, b) => a > b,
      '>=': (a, b) => a >= b,
    };
    for (const op of Object.keys(truth) as ConditionOp[]) {
      for (const level of [0, 1, 2]) cases.push([op, level, truth[op](level, 1)]);
    }
    for (const [op, level, fires] of cases) {
      const { animator } = setup();
      const machine = animator.addStateMachine({
        layer: 'body',
        inputs: [{ name: 'level', type: 'number', value: level }],
        states: [
          { name: 'a', motion: idle },
          { name: 'b', motion: happy },
        ],
        transitions: [{ from: 'a', to: 'b', conditions: [{ input: 'level', op, value: 1 }] }],
      });
      animator.update(0.1);
      expect(machine.state, `${level} ${op} 1`).toBe(fires ? 'b' : 'a');
    }
  });

  it('exit points: landing exactly on one fires, 0 on a loop waits for the next cycle', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      states: [
        { name: 'a', motion: hold('body', 'opacity', 0.2, 1) },
        { name: 'b', motion: hold('body', 'opacity', 0.4, 1, 'loop') },
        { name: 'c', motion: idle },
      ],
      transitions: [
        { from: 'a', to: 'b', exitTime: 0.5 },
        { from: 'b', to: 'c', exitTime: 0 },
      ],
    });
    animator.update(0.25);
    animator.update(0.25);
    expect(machine.state).toBe('b');
    expect(machine.time).toBe(0);
    animator.update(0.5);
    expect(machine.state).toBe('b');
    animator.update(0.5);
    expect(machine.state).toBe('c');
  });

  it('the time in a state is the layer time, so seeking the layer moves exit points too', () => {
    const { animator } = setup();
    const machine = animator.addStateMachine({
      layer: 'body',
      states: [
        { name: 'a', motion: hold('body', 'opacity', 0.2, 1) },
        { name: 'b', motion: idle },
      ],
      transitions: [{ from: 'a', to: 'b', exitTime: 1 }],
    });
    animator.update(0.1);
    layerOf(animator, 'body').time = 0.95;
    animator.update(0.1);
    expect(machine.state).toBe('b');
    expect(machine.time).toBeCloseTo(0.05);
  });

  it('toSpec is a snapshot: later edits of the caller spec do not change it', () => {
    const { animator } = setup();
    const spec = moodMachine();
    const machine = animator.addStateMachine(spec);
    (spec.states as StateSpec[]).push({ name: 'later', motion: idle });
    const first = (spec.transitions as unknown as { duration: number }[])[0];
    if (first) first.duration = 9;
    const copy = machine.toSpec();
    expect(copy.states.map((state) => state.name)).toEqual(['idle', 'happy']);
    expect(copy.transitions?.[0]?.duration).toBe(0.5);
  });

  it('a blend on an additive layer adds its difference from where it started', () => {
    const { body, animator } = setup();
    body.opacity = 0.5;
    animator.inputs.define({ name: 'mood', type: 'number', value: 0.5 });
    const layer = animator.addLayer({ name: 'add', mode: 'additive' });
    layer.play({
      input: 'mood',
      blend: [
        { at: 0, motion: hold('body', 'opacity', 0) },
        { at: 1, motion: hold('body', 'opacity', 0.4) },
      ],
    });
    animator.evaluate();
    expect(body.opacity).toBeCloseTo(0.5);
    animator.inputs.set('mood', 1);
    animator.evaluate();
    // The blend went from 0.2 to 0.4: 0.2 is added to the rest.
    expect(body.opacity).toBeCloseTo(0.7);
  });

  it('a failed add takes back its inputs from blends compiled before the failure', () => {
    const { body, animator } = setup();
    const walk: Blend1D = {
      input: 'speed',
      blend: [
        { at: 0, motion: hold('body', 'opacity', 0) },
        { at: 1, motion: hold('body', 'opacity', 1) },
      ],
    };
    const spec = (lost: boolean): StateMachineSpec => ({
      layer: 'body',
      inputs: [{ name: 'speed', type: 'number' }],
      states: [
        { name: 'walk', motion: walk },
        { name: 'other', motion: lost ? hold('nobody', 'opacity', 1) : idle },
      ],
    });
    expect(() => animator.addStateMachine(spec(true))).toThrow(/state "other"/);
    animator.addStateMachine(spec(false));
    animator.inputs.set('speed', 1);
    animator.update(0);
    expect(body.opacity).toBeCloseTo(1);
  });

  it('a failure entering the initial state takes back the inputs too', () => {
    const { scene, animator } = setup();
    const arm = new Node({ id: 'arm' });
    scene.root.add(arm);
    const layer = layerOf(animator, 'body');
    layer.mask = 'arm';
    arm.destroy();
    expect(() =>
      animator.addStateMachine({
        name: 'masked',
        layer: 'body',
        inputs: [{ name: 'go', type: 'bool' }],
        states: [{ name: 'a', motion: idle }],
      }),
    ).toThrow(/State machine "masked": initial state "a": .*arm/);
    expect(animator.inputs.has('go')).toBe(false);
  });

  it('allows one machine per layer', () => {
    const { animator } = setup();
    animator.addStateMachine(moodMachine());
    expect(() => animator.addStateMachine(moodMachine())).toThrow(/already has a machine/);
  });
});
