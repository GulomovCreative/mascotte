import { Animator, Node, Scene, Sphere } from '@mascotte/engine';
import {
  animateDocument,
  buildDocument,
  FORMAT,
  type MascotDocument,
  readDocument,
  VERSION,
  writeNode,
} from '@mascotte/format';
import { MOTIONS } from '@mascotte/library';
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
      mode: MOTIONS.get(name)?.layer ?? 'override',
      play: name,
    })),
    machines: [],
    constraints: [],
    springs: [],
  };
}

/** The highest the root rises over the first second, as a share of its archetype size. */
function hopHeight(
  document: MascotDocument,
  size: number,
  setup?: (animator: Animator) => void,
): number {
  const built = buildDocument(readDocument(JSON.stringify(document)));
  const animator = new Animator(new Scene(built.root), { rig: built.rig });
  built.animate(animator);
  setup?.(animator);
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

  it('accepts the motions written for an archetype only on mascots that bind their slots', () => {
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

  it('plays library motions inline, in blends and in states, scaled the same way', () => {
    const inline: MascotDocument = {
      ...biped(),
      layers: [{ name: 'jump', mode: 'additive', play: { library: 'hop' } }],
    };
    expect(hopHeight(inline, 30)).toBeCloseTo(0.2, 2);
    const blended: MascotDocument = {
      ...biped(),
      motions: { breathe: { library: 'breathe' } },
      layers: [
        {
          name: 'mix',
          mode: 'additive',
          play: {
            input: 'x',
            blend: [
              { at: 0, motion: 'breathe' },
              { at: 1, motion: { library: 'hop' } },
            ],
          },
        },
        { name: 'rest' },
      ],
      machines: [
        { layer: 'rest', inputs: [{ name: 'x', type: 'number' }], states: [{ name: 'idle' }] },
      ],
    };
    expect(hopHeight(blended, 30, (animator) => animator.inputs.set('x', 1))).toBeCloseTo(0.2, 2);
    const state: MascotDocument = {
      ...biped(),
      layers: [{ name: 'body', mode: 'additive' }],
      machines: [{ layer: 'body', states: [{ name: 'hopping', motion: { library: 'hop' } }] }],
    };
    expect(hopHeight(state, 30)).toBeCloseTo(0.2, 2);
  });

  it('refuses a library motion on the wrong kind of layer, where it would fail silently', () => {
    const wrong =
      (layers: MascotDocument['layers'], machines: MascotDocument['machines'] = []) =>
      () =>
        readDocument({ ...biped(), motions: { hop: { library: 'hop' } }, layers, machines });
    expect(wrong([{ name: 'jump', play: 'hop' }])).toThrow(
      /layers\[0\]\.play: the library motion "hop" is written for an additive layer, but layer "jump" is override\./,
    );
    expect(wrong([{ name: 'eyes', mode: 'additive', play: { library: 'blink' } }])).toThrow(
      /the library motion "blink" is written for an override layer, but layer "eyes" is additive\./,
    );
    expect(
      wrong([{ name: 'body' }], [{ layer: 'body', states: [{ name: 'up', motion: 'hop' }] }]),
    ).toThrow(
      /machines\[0\]\.states\[0\]\.motion: the library motion "hop" is written for an additive layer/,
    );
    // Building without validation refuses it as well.
    const built = buildDocument(readDocument(biped()));
    const animator = new Animator(new Scene(built.root), { rig: built.rig });
    expect(() =>
      animateDocument(
        { archetype: 'biped', layers: [{ name: 'jump', play: { library: 'hop' } }] },
        animator,
      ),
    ).toThrow(/layers\[0\]\.play: the library motion "hop" is written for an additive layer/);
  });

  it("measures the size in the root's parent: a turned root hops as high, a scaled parent scales it", () => {
    const turned = withLibrary(biped());
    const root = turned.root as { props?: Record<string, unknown> };
    root.props = { ...root.props, rotation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 } };
    // Turned a quarter about z, the hop goes along the parent's y all the same.
    expect(hopHeight(turned, 30)).toBeCloseTo(0.2, 2);
    const wrapped: MascotDocument = {
      ...withLibrary(biped()),
      root: {
        type: 'Node',
        id: 'stage',
        props: { scale: { x: 2, y: 2, z: 2 } },
        children: [biped().root],
      },
    };
    // In its parent's units Bip is still 30 high and its root rises 6; on screen both double.
    expect(hopHeight(wrapped, 30)).toBeCloseTo(0.2, 2);
  });

  it('refuses a mascot with no size, unknown library motions and odd library refs', () => {
    const flat = withLibrary(biped());
    const slots = { ...(flat.rig?.slots ?? {}), head: 'feet' };
    const built = buildDocument(readDocument({ ...flat, rig: { slots } }));
    expect(() => built.animate(new Animator(new Scene(built.root), { rig: built.rig }))).toThrow(
      /the slots root and head are at one point, so the mascot has no size\./,
    );
    // Motions that move no position need no size.
    const still = buildDocument(
      readDocument({
        ...withLibrary(biped()),
        rig: { slots },
        motions: { blink: { library: 'blink' } },
        layers: [{ name: 'eyes', play: 'blink' }],
      }),
    );
    expect(() =>
      still.animate(new Animator(new Scene(still.root), { rig: still.rig })),
    ).not.toThrow();
    expect(() => readDocument({ ...biped(), motions: { a: { library: 'moonwalk' } } })).toThrow(
      /motions\.a\.library: expected a library motion \(breathe, blink, hop, .*\), got "moonwalk"\./,
    );
    expect(() =>
      readDocument({ ...biped(), motions: { a: { library: 'hop', tracks: [] } } }),
    ).toThrow(/motions\.a\.tracks: unknown field/);
    const { rig, ...noRig } = withLibrary(biped());
    expect(rig).toBeDefined();
    expect(() => readDocument(noRig)).toThrow(/the library motion "hop" needs the slots root/);
    // An unknown archetype is reported once, not again by every motion that needs a size.
    let message = '';
    try {
      readDocument({ ...withLibrary(biped()), archetype: 'dragon' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/archetype: expected one of/);
    expect(message).not.toMatch(/set an archetype/);
  });
});
