import { Animator, type Node, Scene, type Sphere } from '@mascotte/engine';
import { buildDocument, readDocument } from '@mascotte/format';
import { describe, expect, it } from 'vitest';
import { gloopDocument, misoDocument, pipDocument } from '../src/index.ts';

/**
 * The reference mascots, with what a poke does (Gloop and Miso hop, Pip startles in place) and
 * a node whose color comes from the palette (none for Pip, which has no palettes).
 */
const mascots = [
  { name: 'gloop', document: gloopDocument, hops: true, colored: 'blob' },
  { name: 'miso', document: misoDocument, hops: true, colored: 'skull' },
  { name: 'pip', document: pipDocument(), hops: false, colored: null },
] as const;

/** The library motions a document refers to. */
function libraryMotions(value: unknown): string[] {
  const motions = (value as { motions?: Record<string, { library?: string }> }).motions ?? {};
  return Object.values(motions).flatMap((motion) => (motion.library ? [motion.library] : []));
}

function play(value: unknown, params?: Record<string, number>) {
  const built = buildDocument(readDocument(JSON.stringify(value)), params ? { params } : {});
  const scene = new Scene(built.root);
  const animator = new Animator(scene, { rig: built.rig });
  const { machines } = built.animate(animator);
  const slot = (name: string): Node => {
    const node = built.rig.node(name);
    if (!node) throw new Error(`no slot ${name}`);
    return node;
  };
  return { built, scene, animator, machines, slot };
}

describe('reference mascots', () => {
  it('are of three archetypes and share library motions', () => {
    const archetypes = mascots.map(({ document }) => readDocument(document).archetype);
    expect(new Set(archetypes).size).toBe(3);
    const [first, ...rest] = mascots.map(({ document }) => libraryMotions(document));
    const shared = (first ?? []).filter((name) => rest.every((names) => names.includes(name)));
    expect(shared).toEqual(['blink']);
  });

  it.each(mascots)('$name blinks and answers a poke over its shadow', ({ document, hops }) => {
    const { animator, machines, slot, scene } = play(document);
    const shadow = scene.getById('shadow');
    if (!shadow) throw new Error('no shadow');
    const ground = shadow.getWorldPosition({ x: 0, y: 0, z: 0 }).y;
    const root = slot('root');
    const eyes = slot('eyes');
    const lids = slot('lids');
    const rest = root.position.y;
    let blinks = 0;
    for (let frame = 0; frame < 60 * 6; frame++) {
      animator.update(1 / 60);
      if (!eyes.visible && lids.visible) blinks++;
    }
    expect(blinks).toBeGreaterThan(0);
    const states = new Set<string>();
    animator.inputs.fire('poke');
    let highest = 0;
    for (let frame = 0; frame < 60; frame++) {
      animator.update(1 / 60);
      highest = Math.max(highest, rest - root.position.y);
      for (const machine of machines) states.add(machine.state);
      // The shadow stands beside the mascot's root: it stays on the ground.
      expect(shadow.getWorldPosition({ x: 0, y: 0, z: 0 }).y).toBe(ground);
    }
    if (hops) {
      // A hop is a fifth of the size high: well over the bob of an idle second.
      expect(highest).toBeGreaterThan(5);
      expect(states).toContain('hop');
    } else {
      expect(highest).toBeLessThan(1);
      expect(states).toContain('surprised');
    }
  });

  it.each(mascots.filter(({ colored }) => colored))(
    '$name switches its palettes',
    ({ document, colored }) => {
      const { built, scene, animator } = play(document);
      const node = scene.getById(colored as string) as Sphere;
      const [base, other] = built.palettes;
      expect(built.palettes).toHaveLength(2);
      const before = node.style.color;
      built.palette(other as string, animator);
      animator.update(1 / 60);
      expect(node.style.color).not.toBe(before);
      built.palette(base as string, animator);
      animator.update(1 / 60);
      expect(node.style.color).toBe(before);
    },
  );

  it("follow their shape parameters: Gloop's eye size, Miso's ear length", () => {
    const eye = (eyeSize: number) =>
      (play(gloopDocument, { eyeSize }).scene.getById('eye-left-white') as Sphere).diameter;
    expect([eye(10), eye(28)]).toEqual([10, 28]);
    // The ear's top: the lowest y of its path, which goes up (−y) from its base.
    const ear = (earLength: number) => {
      const shape = play(misoDocument, { earLength }).scene.getById('ear-left') as unknown as {
        path: readonly { point: { y: number } }[];
      };
      return Math.min(...shape.path.map((command) => command.point.y));
    };
    expect([ear(8), ear(22)]).toEqual([-8, -22]);
  });
});
