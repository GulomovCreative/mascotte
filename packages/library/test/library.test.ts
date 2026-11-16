import { Animator, Node, Rig, Scene } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { ARCHETYPES, MOTIONS, scaleMotion, slotsOf, usesSize } from '../src/index.ts';

/** A scene with one node per slot, bound by a rig to those slots. */
function rigFor(slots: readonly string[]) {
  const root = new Node({ id: 'n-root' });
  const bindings: Record<string, string> = { root: 'n-root' };
  for (const slot of slots) {
    if (slot === 'root') continue;
    const id = `n-${slot}`;
    root.add(new Node({ id }));
    bindings[slot] = id;
  }
  const scene = new Scene(root);
  return { scene, rig: new Rig(root, bindings) };
}

describe('archetypes', () => {
  it('bind the common slots, keep optional ones apart and measure by slots they bind', () => {
    expect([...ARCHETYPES.keys()]).toEqual(['blob', 'biped', 'quadruped', 'bird', 'face']);
    for (const archetype of ARCHETYPES.values()) {
      for (const slot of ['root', 'body', 'eyes', 'lids']) expect(archetype.slots).toContain(slot);
      for (const slot of archetype.optional) expect(archetype.slots).not.toContain(slot);
      for (const slot of archetype.size) expect(archetype.slots).toContain(slot);
      expect(new Set(archetype.slots).size).toBe(archetype.slots.length);
    }
  });
});

describe('the motion library', () => {
  it('every motion fits some archetype and plays on a rig that binds its slots', () => {
    for (const entry of MOTIONS.values()) {
      const slots = slotsOf(entry.motion);
      expect(slots.length, entry.name).toBeGreaterThan(0);
      const fits = [...ARCHETYPES.values()].filter((archetype) =>
        slots.every((slot) => archetype.slots.includes(slot) || archetype.optional.includes(slot)),
      );
      expect(fits.length, entry.name).toBeGreaterThan(0);
      const { scene, rig } = rigFor(slots);
      const animator = new Animator(scene, { rig });
      animator
        .addLayer({ name: entry.name, mode: entry.layer })
        .play(scaleMotion(entry.motion, 100));
      for (let frame = 0; frame < 120; frame++) animator.update(1 / 60);
    }
  });

  it('shared motions use only the slots every archetype has, or the head', () => {
    const everywhere = new Set(['root', 'body', 'eyes', 'lids', 'head']);
    for (const name of ['breathe', 'blink', 'hop', 'bob', 'sway', 'tilt']) {
      const motion = MOTIONS.get(name)?.motion;
      if (!motion) throw new Error(`no ${name}`);
      for (const slot of slotsOf(motion))
        expect(everywhere.has(slot), `${name}: ${slot}`).toBe(true);
    }
    expect(slotsOf((MOTIONS.get('wave') ?? { motion: { tracks: [] } }).motion as never)).toEqual([
      'arm.R',
    ]);
  });

  it('scales positions by the size and leaves everything else', () => {
    const hop = MOTIONS.get('hop')?.motion;
    const breathe = MOTIONS.get('breathe')?.motion;
    if (!hop || !breathe || !('tracks' in hop)) throw new Error('no hop or breathe');
    expect(usesSize(hop)).toBe(true);
    expect(usesSize(breathe)).toBe(false);
    const scaled = scaleMotion(hop, 50);
    if (!('tracks' in scaled)) throw new Error('not a clip');
    expect(scaled.tracks[0]?.keys[1]?.value).toEqual({ x: 0, y: -10, z: 0 });
    expect(hop.tracks[0]?.keys[1]?.value).toEqual({ x: 0, y: -0.2, z: 0 });
    expect(scaleMotion(breathe, 50)).toEqual(breathe);
  });
});
