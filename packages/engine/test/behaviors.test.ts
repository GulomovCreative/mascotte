import { describe, expect, it } from 'vitest';
import { Animator, type Behavior, type BehaviorSet, Node, PathShape, Scene } from '../src/index.ts';

function setup() {
  const scene = new Scene();
  const body = new Node({ id: 'body' });
  const eye = new PathShape({ id: 'eye' });
  const lid = new PathShape({ id: 'lid', visible: false });
  body.add(eye);
  body.add(lid);
  scene.root.add(body);
  return { scene, body, eye, lid, animator: new Animator(scene) };
}

function set(...behaviors: Behavior[]): BehaviorSet {
  return { behaviors };
}

/** Plays `behavior` on the eye opacity from 0 to 1 and returns its weight at `times`. */
function weights(behavior: Partial<Behavior> & Pick<Behavior, 'kind'>, times: number[]): number[] {
  const { eye, animator } = setup();
  const layer = animator.addLayer();
  layer.play(set({ target: 'eye', property: 'opacity', from: 0, to: 1, ...behavior } as Behavior));
  return times.map((time) => {
    layer.time = time;
    animator.evaluate();
    return eye.opacity;
  });
}

const blink = {
  kind: 'blink' as const,
  duration: 0.3,
  minInterval: 2,
  maxInterval: 5,
  seed: 11,
};

/** Blink starts (where the weight leaves 0) on a fine grid over `seconds`. */
function blinkStarts(options: Partial<typeof blink>, seconds: number): number[] {
  const step = 0.005;
  const times = Array.from({ length: seconds / step }, (_, i) => i * step);
  const values = weights({ ...blink, ...options }, times);
  const starts: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if ((values[i - 1] as number) === 0 && (values[i] as number) > 0)
      starts.push(times[i] as number);
  }
  return starts;
}

describe('oscillate', () => {
  it('goes from `from` to `to` and back once per period, shifted by the phase', () => {
    const at = weights({ kind: 'oscillate', period: 2 }, [0, 0.5, 1, 1.5, 2, 3]);
    expect(at.map((v) => Number(v.toFixed(6)))).toEqual([0, 0.5, 1, 0.5, 0, 1]);
    const shifted = weights({ kind: 'oscillate', period: 2, phase: 0.5 }, [0, 1]);
    expect(shifted[0]).toBeCloseTo(1);
    expect(shifted[1]).toBeCloseTo(0);
  });

  it('mixes vectors and rotations like clip keys', () => {
    const { body, animator } = setup();
    animator.addLayer().play(
      set(
        {
          kind: 'oscillate',
          target: 'body',
          property: 'position',
          from: { x: 0, y: 0, z: 0 },
          to: { x: 0, y: -4, z: 2 },
          period: 4,
        },
        {
          kind: 'oscillate',
          target: 'body',
          property: 'rotation',
          from: { x: 0, y: 0, z: 0, w: 1 },
          to: { x: 0, y: 1, z: 0, w: 0 },
          period: 4,
        },
      ),
    );
    animator.update(1);
    expect(body.position.y).toBeCloseTo(-2);
    expect(body.position.z).toBeCloseTo(1);
    // Half way through a half turn: a quarter turn.
    expect(body.rotation.y).toBeCloseTo(Math.SQRT1_2);
    expect(body.rotation.w).toBeCloseTo(Math.SQRT1_2);
  });
});

describe('blink', () => {
  it('rests at `from`, reaches `to` in the first third and returns within the duration', () => {
    const starts = blinkStarts({}, 20);
    expect(starts.length).toBeGreaterThan(0);
    const first = starts[0] as number;
    const [before, closed, after] = weights(blink, [first - 0.01, first + 0.1, first + 0.31]);
    expect(before).toBe(0);
    expect(closed).toBeCloseTo(1, 1);
    expect(after).toBe(0);
    expect(weights(blink, [0])[0]).toBe(0);
  });

  it('blinks at random intervals within the limits, the same for the same seed', () => {
    const starts = blinkStarts({}, 120);
    const gaps = starts.slice(1).map((start, i) => start - (starts[i] as number));
    // The grid step is 0.005 s.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2 - 0.01);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(5 + 0.01);
    // Not a fixed rhythm: the gaps differ.
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(1);
    // About 120 s / 3.5 s on average.
    expect(starts.length).toBeGreaterThan(25);
    expect(starts.length).toBeLessThan(45);
    expect(blinkStarts({}, 30)).toEqual(starts.filter((start) => start < 30 - 0.005));
    expect(blinkStarts({ seed: 12 }, 30)).not.toEqual(blinkStarts({}, 30));
  });

  it('switches booleans half way, so shapes can swap for a blink', () => {
    const { eye, lid, animator } = setup();
    animator
      .addLayer()
      .play(
        set(
          { ...blink, target: 'eye', property: 'visible', from: true, to: false },
          { ...blink, target: 'lid', property: 'visible', from: false, to: true },
        ),
      );
    const first = blinkStarts({}, 20)[0] as number;
    const layer = animator.layers[0];
    if (!layer) throw new Error('no layer');
    layer.time = first + 0.1;
    animator.evaluate();
    expect([eye.visible, lid.visible]).toEqual([false, true]);
    layer.time = first + 0.29;
    animator.evaluate();
    expect([eye.visible, lid.visible]).toEqual([true, false]);
  });
});

describe('noise', () => {
  it('starts at the middle, stays between the values and changes smoothly', () => {
    const step = 0.01;
    const times = Array.from({ length: 1000 }, (_, i) => i * step);
    const values = weights({ kind: 'noise', frequency: 2, seed: 5 }, times);
    expect(values[0]).toBeCloseTo(0.5);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.3);
    for (let i = 1; i < values.length; i++) {
      expect(Math.abs((values[i] as number) - (values[i - 1] as number))).toBeLessThan(0.05);
    }
    const other = weights({ kind: 'noise', frequency: 2, seed: 6 }, times);
    expect(other).not.toEqual(values);
  });
});

describe('behaviors on layers', () => {
  it('seeking gives the same frame as playback', () => {
    const make = () => {
      const world = setup();
      const layer = world.animator.addLayer({ mode: 'additive' });
      layer.play(
        set(
          { ...blink, target: 'eye', property: 'opacity', from: 1, to: 0 },
          {
            kind: 'noise',
            target: 'body',
            property: 'position',
            from: { x: -1, y: 0, z: 0 },
            to: { x: 1, y: 0, z: 0 },
            frequency: 1.5,
            seed: 3,
          },
        ),
      );
      return { ...world, layer };
    };
    const played = make();
    for (let i = 0; i < 600; i++) played.animator.update(1 / 60);
    const sought = make();
    sought.layer.time = played.layer.time;
    sought.animator.evaluate();
    expect(sought.eye.opacity).toBe(played.eye.opacity);
    expect(sought.body.position.x).toBe(played.body.position.x);
  });

  it('an additive breathing layer offsets a clip by its distance from the neutral value', () => {
    const { body, animator } = setup();
    animator.addLayer().play({
      duration: 1,
      loop: 'once',
      tracks: [
        { target: 'body', property: 'position', keys: [{ time: 0, value: { x: 3, y: 10, z: 0 } }] },
      ],
    });
    animator.addLayer({ mode: 'additive' }).play(
      set({
        kind: 'oscillate',
        target: 'body',
        property: 'position',
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: -2, z: 0 },
        period: 4,
      }),
    );
    animator.update(2);
    expect(body.position.x).toBeCloseTo(3);
    expect(body.position.y).toBeCloseTo(8);
  });

  it('rejects unknown kinds, invalid parameters and values', () => {
    const { animator } = setup();
    const layer = animator.addLayer();
    const base = { target: 'eye', property: 'opacity', from: 0, to: 1 };
    const play = (behavior: object) => () => layer.play(set({ ...base, ...behavior } as Behavior));
    expect(play({ kind: 'wiggle' })).toThrow(/Behavior eye\.opacity: unknown kind "wiggle"/);
    expect(play({ kind: 'oscillate', period: 0 })).toThrow(RangeError);
    expect(play({ kind: 'oscillate', period: 1, phase: Number.NaN })).toThrow(/phase/);
    expect(play({ ...blink, maxInterval: 1 })).toThrow(/maxInterval/);
    expect(play({ ...blink, duration: 3 })).toThrow(/longer than minInterval/);
    expect(play({ ...blink, seed: 0.5 })).toThrow(/seed/);
    expect(play({ kind: 'noise', frequency: Infinity })).toThrow(/frequency/);
    expect(play({ kind: 'noise', frequency: 1, to: 'high' })).toThrow(
      'Behavior eye.opacity: to must be a finite number.',
    );
    expect(play({ kind: 'noise', frequency: 1, from: 2 })).toThrow(/from value 2 is outside/);
    expect(play({ kind: 'noise', frequency: 1, target: 'nobody' })).toThrow(/nobody/);
  });
});
