import { Animator, Node, Scene, Sphere } from '@mascotte/engine';
import {
  buildDocument,
  FORMAT,
  type MascotDocument,
  readDocument,
  VERSION,
  writeNode,
} from '@mascotte/format';
import { describe, expect, it } from 'vitest';
import { pipDocument } from '../src/index.ts';

/** A small biped: feet at the root, a body, a head 30 above the feet, eyes, lids and arms. */
function biped(): MascotDocument {
  const root = new Node({ id: 'feet' });
  const body = new Sphere({ id: 'torso', diameter: 20, position: { x: 0, y: -12, z: 0 } });
  const head = new Sphere({ id: 'noggin', diameter: 16, position: { x: 0, y: -18, z: 0 } });
  head.add(new Node({ id: 'peepers' }));
  head.add(new Node({ id: 'shut', visible: false }));
  body.add(head);
  body.add(new Node({ id: 'left-arm' }));
  body.add(new Node({ id: 'right-arm' }));
  root.add(body);
  return {
    format: FORMAT,
    version: VERSION,
    meta: { name: 'Bip' },
    archetype: 'biped',
    view: { width: 100, height: 100 },
    root: writeNode(root),
    rig: {
      slots: {
        root: 'feet',
        body: 'torso',
        head: 'noggin',
        eyes: 'peepers',
        lids: 'shut',
        'arm.L': 'left-arm',
        'arm.R': 'right-arm',
      },
    },
  };
}

/** `document` with only the shared library motions on its layers. */
function withLibrary(document: MascotDocument, extra: string[] = []): MascotDocument {
  const names = ['hop', 'blink', 'breathe', ...extra];
  return {
    ...document,
    motions: Object.fromEntries(names.map((name) => [name, { library: name }])),
    layers: names.map((name) => ({
      name,
      mode: name === 'blink' || name === 'wave' ? 'override' : 'additive',
      play: name,
    })),
    machines: [],
    constraints: [],
    springs: [],
  };
}

/** The highest the root rises over the first second, as a share of its archetype size. */
function hopHeight(document: MascotDocument, size: number): number {
  const built = buildDocument(readDocument(JSON.stringify(document)));
  const animator = new Animator(new Scene(built.root), { rig: built.rig });
  built.animate(animator);
  const root = built.rig.node('root');
  if (!root) throw new Error('no root');
  const rest = root.position.y;
  let highest = 0;
  for (let frame = 0; frame < 60; frame++) {
    animator.update(1 / 60);
    highest = Math.max(highest, rest - root.position.y);
  }
  return highest / size;
}

describe('the motion library on mascots of different archetypes', () => {
  it('shares one hop, scaled to each mascot: a fifth of its size high', () => {
    // Bip's head is 30 above its feet; Pip's is 52 (its body radius).
    expect(hopHeight(withLibrary(biped()), 30)).toBeCloseTo(0.2, 2);
    expect(hopHeight(withLibrary(pipDocument()), 52)).toBeCloseTo(0.2, 2);
  });

  it('plays the motions written for an archetype only on mascots that bind their slots', () => {
    expect(() => readDocument(withLibrary(biped(), ['wave']))).not.toThrow();
    expect(() => readDocument(withLibrary(pipDocument(), ['flap', 'chirp']))).not.toThrow();
    expect(() => readDocument(withLibrary(pipDocument(), ['wave']))).toThrow(
      /motions\.wave\.library: the library motion "wave" needs the slots arm\.R, which the rig does not bind\./,
    );
  });

  it('checks the archetype a document declares against its rig', () => {
    const { rig, ...rest } = biped();
    expect(() => readDocument({ ...rest, rig: { slots: { root: 'feet' } } })).toThrow(
      /archetype: a biped binds the slots body, eyes, lids, head, arm\.L, arm\.R, which the rig does not\./,
    );
    expect(() => readDocument({ ...biped(), archetype: 'dragon' })).toThrow(
      /archetype: expected one of blob, biped, quadruped, bird, face, got "dragon"\./,
    );
    const { archetype, ...plain } = withLibrary(biped());
    expect(() => readDocument(plain)).toThrow(
      /the library motion "hop" moves positions in sizes of the mascot: set an archetype/,
    );
    expect(archetype).toBe('biped');
  });
});
