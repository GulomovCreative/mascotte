import { Animator, Scene } from '@mascotte/engine';
import { buildDocument, readDocument } from '@mascotte/format';
import { describe, expect, it } from 'vitest';
import { gloopDocument, misoDocument, pipDocument } from '../src/index.ts';

const mascots = { gloop: gloopDocument, miso: misoDocument, pip: pipDocument() };

/** The library motions a document refers to. */
function libraryMotions(value: unknown): string[] {
  const motions = (value as { motions?: Record<string, { library?: string }> }).motions ?? {};
  return Object.values(motions).flatMap((motion) => (motion.library ? [motion.library] : []));
}

describe('reference mascots', () => {
  it('are of three archetypes and share library motions', () => {
    const documents = Object.values(mascots).map((value) => readDocument(value));
    expect(new Set(documents.map((document) => document.archetype)).size).toBe(3);
    const [first, ...rest] = Object.values(mascots).map(libraryMotions);
    const shared = (first ?? []).filter((name) => rest.every((names) => names.includes(name)));
    expect(shared).toContain('blink');
  });

  it.each(Object.entries(mascots))('%s builds, animates and reacts to a poke', (_, value) => {
    const document = readDocument(JSON.stringify(value));
    const built = buildDocument(document);
    const scene = new Scene(built.root);
    const animator = new Animator(scene, { rig: built.rig });
    built.animate(animator);
    const root = built.rig.node('root');
    if (!root) throw new Error('no root');
    const rest = root.position.y;
    animator.inputs.fire('poke');
    let highest = 0;
    for (let frame = 0; frame < 60; frame++) {
      animator.update(1 / 60);
      highest = Math.max(highest, rest - root.position.y);
    }
    // Gloop and Miso hop; Pip startles in place.
    if (document.meta.name !== 'Pip') expect(highest).toBeGreaterThan(5);
    for (const name of built.palettes) built.palette(name, animator);
  });

  it('take shape parameters', () => {
    const ear = (length: number) => {
      const built = buildDocument(readDocument(misoDocument), { params: { earLength: length } });
      const tip = new Scene(built.root).getById('ear-left') as unknown as {
        path: readonly { point: { y: number } }[];
      };
      return tip.path[2]?.point.y;
    };
    expect([ear(8), ear(22)]).toEqual([-8, -22]);
  });
});
