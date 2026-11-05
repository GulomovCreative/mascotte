import { quat, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import { Animator, type Clip, Node, Scene, SPRING_STEP, type SpringOptions } from '../src/index.ts';

/** A root, an `arm` turned by the tests and an `ear` at its origin pointing up. */
function setup(options: Partial<SpringOptions> = {}) {
  const root = new Node({ id: 'root' });
  const arm = new Node({ id: 'arm' });
  const ear = new Node({ id: 'ear' });
  arm.add(ear);
  root.add(arm);
  const scene = new Scene(root);
  const animator = new Animator(scene);
  const spring = animator.addSpring({ target: 'ear', tip: { x: 0, y: 10, z: 0 }, ...options });
  return { root, arm, ear, scene, animator, spring };
}

function turnZ(node: Node, angle: number): void {
  node.rotation.copy(quat.setAxisAngle(quat.create(), vec3.create(0, 0, 1), angle));
}

/** The angle of the ear about Z in the arm's space (0 when it hangs as posed). */
function earAngle(ear: Node): number {
  const q = ear.rotation;
  return 2 * Math.atan2(q.z, q.w);
}

/** The world angle of the ear tip about the ear's pivot, from the Y axis. */
function tipAngle(ear: Node): number {
  const tip = ear.localToWorld(vec3.create(), { x: 0, y: 10, z: 0 });
  const pivot = ear.localToWorld(vec3.create(), ear.pivot);
  return Math.atan2(-(tip.x - pivot.x), tip.y - pivot.y);
}

/** Plays `seconds` at `fps`, calling `before(time)` before every frame. */
function play(animator: Animator, seconds: number, fps: number, before?: (t: number) => void) {
  const frames = Math.round(seconds * fps);
  for (let i = 1; i <= frames; i++) {
    before?.(i / fps);
    animator.update(1 / fps);
  }
}

describe('springs', () => {
  it('leave a node at rest in its pose, taking its rotation as rest when added', () => {
    const root = new Node({ id: 'root' });
    const ear = new Node({ id: 'ear' });
    root.add(ear);
    turnZ(ear, 0.3);
    const animator = new Animator(new Scene(root));
    animator.addSpring({ target: 'ear', tip: { x: 0, y: 10, z: 0 } });
    animator.evaluate();
    expect(earAngle(ear)).toBeCloseTo(0.3, 12);
    play(animator, 1, 60);
    expect(earAngle(ear)).toBeCloseTo(0.3, 12);
    // The animator owns the rotation now: setting it directly is undone by the next frame.
    turnZ(ear, 1);
    animator.update(1 / 60);
    expect(earAngle(ear)).toBeCloseTo(0.3, 12);
  });

  it('lag behind a turning parent, swing past and settle in the pose', () => {
    const { arm, ear, animator } = setup({ frequency: 2, damping: 0.3 });
    animator.update(1 / 60);
    turnZ(arm, 0.5);
    animator.update(1 / 60);
    // Right after the turn the tip has hardly moved in the world.
    expect(Math.abs(tipAngle(ear))).toBeLessThan(0.1);
    expect(earAngle(ear)).toBeLessThan(-0.4);
    let most = 0;
    play(animator, 1, 60, () => {
      most = Math.max(most, tipAngle(ear));
    });
    expect(most).toBeGreaterThan(0.6);
    play(animator, 5, 60);
    expect(tipAngle(ear)).toBeCloseTo(0.5, 4);
    expect(earAngle(ear)).toBeCloseTo(0, 4);
  });

  it('do not swing past with damping 1 and keep swinging with damping 0', () => {
    const run = (damping: number) => {
      const { arm, ear, animator } = setup({ frequency: 3, damping });
      animator.update(1 / 60);
      turnZ(arm, 0.4);
      const angles: number[] = [];
      play(animator, 4, 60, () => angles.push(tipAngle(ear)));
      return angles;
    };
    const critical = run(1);
    // The pulling point jumps within a frame, so the steps may pass it by a hair.
    expect(Math.max(...critical)).toBeLessThanOrEqual(0.4 + 1e-3);
    const free = run(0);
    expect(Math.max(...free.slice(-60))).toBeGreaterThan(0.7);
    expect(Math.min(...free.slice(-60))).toBeLessThan(0.1);
  });

  it('swing at their frequency', () => {
    const { arm, ear, animator } = setup({ frequency: 2, damping: 0 });
    animator.update(1 / 120);
    turnZ(arm, 0.2);
    const crossings: number[] = [];
    let last = tipAngle(ear) - 0.2;
    play(animator, 3, 120, (t) => {
      const now = tipAngle(ear) - 0.2;
      if (last < 0 && now >= 0) crossings.push(t);
      last = now;
    });
    const periods = crossings.slice(1).map((t, i) => t - (crossings[i] as number));
    for (const period of periods) expect(period).toBeCloseTo(0.5, 1);
  });

  it('move the same at different frame rates', () => {
    const at = (fps: number) => {
      const { arm, ear, animator } = setup({ frequency: 2.5, damping: 0.2 });
      play(animator, 2, fps, (t) => turnZ(arm, Math.sin(t * 5) * 0.6));
      return tipAngle(ear);
    };
    const reference = at(120);
    for (const fps of [30, 60, 75, 144]) expect(at(fps), String(fps)).toBeCloseTo(reference, 2);
  });

  it('give the same motion when the same frames are played again', () => {
    const { arm, ear, animator } = setup({ damping: 0.1 });
    const run = () => {
      const angles: number[] = [];
      for (let i = 1; i <= 100; i++) {
        turnZ(arm, Math.min(i / 50, 0.5));
        animator.update(1 / 50);
        angles.push(earAngle(ear));
      }
      return angles;
    };
    const first = run();
    turnZ(arm, 0);
    animator.resetSprings();
    expect(run()).toEqual(first);
  });

  it('do not build up: evaluate keeps the frame and the turn comes from the pose', () => {
    const { arm, ear, animator } = setup();
    animator.update(1 / 60);
    turnZ(arm, 0.5);
    play(animator, 0.2, 60);
    const angle = earAngle(ear);
    animator.evaluate();
    animator.evaluate();
    expect(earAngle(ear)).toBeCloseTo(angle, 12);
    animator.update(0);
    expect(earAngle(ear)).toBeCloseTo(angle, 12);
  });

  it('show the plain pose while disabled and start at rest when enabled again', () => {
    const { arm, ear, animator } = setup();
    animator.update(1 / 60);
    turnZ(arm, 0.5);
    play(animator, 0.1, 60);
    expect(Math.abs(earAngle(ear))).toBeGreaterThan(0.1);
    animator.springsEnabled = false;
    expect(animator.springsEnabled).toBe(false);
    animator.evaluate();
    expect(earAngle(ear)).toBe(0);
    play(animator, 0.1, 60);
    expect(earAngle(ear)).toBe(0);
    animator.springsEnabled = true;
    animator.update(1 / 60);
    expect(earAngle(ear)).toBeCloseTo(0, 12);
  });

  it('settle instead of simulating a long frame', () => {
    const { arm, ear, animator } = setup({ damping: 0 });
    animator.update(1 / 60);
    turnZ(arm, 1);
    animator.update(1);
    expect(earAngle(ear)).toBeCloseTo(0, 12);
    expect(tipAngle(ear)).toBeCloseTo(1, 12);
  });

  it('lag behind a moving ancestor too', () => {
    const { root, ear, animator } = setup({ frequency: 2, damping: 0.5 });
    animator.update(1 / 60);
    root.position.x = 5;
    animator.update(1 / 60);
    // The tip stays behind (to the left) when the root moves right.
    expect(tipAngle(ear)).toBeGreaterThan(0.2);
    play(animator, 4, 60);
    expect(tipAngle(ear)).toBeCloseTo(0, 4);
  });

  it('turn on top of a clip that animates the same rotation', () => {
    const { arm, ear, animator } = setup({ frequency: 2, damping: 0.5 });
    const turned = quat.setAxisAngle(quat.create(), vec3.create(0, 0, 1), 0.3);
    const clip: Clip = {
      duration: 1,
      loop: 'loop',
      tracks: [
        {
          target: 'ear',
          property: 'rotation',
          keys: [{ time: 0, value: { x: turned.x, y: turned.y, z: turned.z, w: turned.w } }],
        },
      ],
    };
    animator.addLayer().play(clip);
    play(animator, 0.5, 60);
    expect(earAngle(ear)).toBeCloseTo(0.3, 9);
    turnZ(arm, -0.4);
    animator.update(1 / 60);
    expect(earAngle(ear)).toBeGreaterThan(0.6);
    play(animator, 5, 60);
    expect(earAngle(ear)).toBeCloseTo(0.3, 4);
  });

  it('limit the turn to maxAngle', () => {
    const { arm, ear, animator } = setup({ maxAngle: 0.2, frequency: 1, damping: 1 });
    animator.update(1 / 60);
    turnZ(arm, 1);
    for (let i = 0; i < 60; i++) {
      animator.update(1 / 60);
      expect(Math.abs(earAngle(ear))).toBeLessThanOrEqual(0.2 + 1e-9);
    }
  });

  it('turn in the parent space under a non-uniform scale', () => {
    const { arm, ear, animator, spring } = setup({ frequency: 1, damping: 1 });
    arm.scale.x = 3;
    animator.update(1 / 60);
    arm.position.x = 4;
    animator.update(1 / 60);
    // The node turns so that the tip lies on the line from the pivot to the particle: here the
    // particle is still at the old tip.
    const tip = ear.localToWorld(vec3.create(), spring.tip);
    const pivot = ear.localToWorld(vec3.create(), ear.pivot);
    const toParticle = vec3.sub(vec3.create(), { x: 0, y: 10, z: 0 }, pivot);
    const toTip = vec3.sub(vec3.create(), tip, pivot);
    const cross = toTip.x * toParticle.y - toTip.y * toParticle.x;
    expect(Math.abs(cross) / (vec3.length(toTip) * vec3.length(toParticle))).toBeLessThan(0.02);
  });

  it('run parents before children whatever the order they were added in', () => {
    const root = new Node({ id: 'root' });
    const a = new Node({ id: 'a' });
    const b = new Node({ id: 'b', position: { x: 0, y: 10, z: 0 } });
    const c = new Node({ id: 'c', position: { x: 0, y: 10, z: 0 } });
    root.add(a);
    a.add(b);
    b.add(c);
    const animator = new Animator(new Scene(root));
    const tip = { x: 0, y: 10, z: 0 };
    const sc = animator.addSpring({ target: 'c', tip });
    const sa = animator.addSpring({ target: 'a', tip });
    const sb = animator.addSpring({ target: 'b', tip });
    expect(animator.springs).toEqual([sa, sb, sc]);
    animator.removeSpring(sb);
    expect(animator.springs).toEqual([sa, sc]);
    animator.removeSpring(sb);
    expect(animator.springs).toEqual([sa, sc]);
  });

  it('skip a destroyed node', () => {
    const { ear, animator } = setup();
    animator.update(1 / 60);
    ear.destroy();
    expect(() => animator.update(1 / 60)).not.toThrow();
  });

  it('simulate at a fixed step', () => {
    expect(SPRING_STEP).toBe(1 / 120);
    // Frames shorter than a step move the particle on smoothly.
    const { arm, ear, animator } = setup({ damping: 0.5 });
    animator.update(1 / 60);
    turnZ(arm, 0.5);
    const angles: number[] = [];
    for (let i = 0; i < 20; i++) {
      animator.update(SPRING_STEP / 4);
      angles.push(tipAngle(ear));
    }
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i] as number).toBeGreaterThanOrEqual((angles[i - 1] as number) - 1e-12);
    }
  });

  it('check their options', () => {
    const { animator } = setup();
    const tip = { x: 0, y: 10, z: 0 };
    expect(() => animator.addSpring({ target: 'nope', tip })).toThrow(/no node with id "nope"/);
    for (const frequency of [0, -1, 21, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => animator.addSpring({ target: 'arm', tip, frequency }),
        String(frequency),
      ).toThrow(RangeError);
    }
    for (const damping of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => animator.addSpring({ target: 'arm', tip, damping }), String(damping)).toThrow(
        RangeError,
      );
    }
    for (const maxAngle of [0, -1, 4, Number.NaN]) {
      expect(() => animator.addSpring({ target: 'arm', tip, maxAngle }), String(maxAngle)).toThrow(
        RangeError,
      );
    }
    expect(() => animator.addSpring({ target: 'arm', tip: { x: 0, y: 0, z: 0 } })).toThrow(
      /Spring arm: tip must differ from the pivot/,
    );
    expect(() => animator.addSpring({ target: 'arm', tip: { x: Number.NaN, y: 0, z: 0 } })).toThrow(
      RangeError,
    );
    expect(animator.springs).toHaveLength(1);
    const spring = animator.springs[0];
    if (!spring) throw new Error('no spring');
    expect(() => {
      spring.frequency = 0;
    }).toThrow(RangeError);
    expect(() => {
      spring.damping = -1;
    }).toThrow(RangeError);
    expect(() => {
      spring.maxAngle = 5;
    }).toThrow(RangeError);
    spring.frequency = 4;
    spring.damping = 0.8;
    spring.maxAngle = 1;
    expect([spring.frequency, spring.damping, spring.maxAngle]).toEqual([4, 0.8, 1]);
  });
});
