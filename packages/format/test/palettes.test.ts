import { Animator, type BlobShadow, type Box, Scene, type Sphere } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  FORMAT,
  type MascotDocument,
  readDocument,
  VERSION,
  validateDocument,
  writeNode,
} from '../src/index.ts';

/** A ball and a box colored by role, with a light and a partial dark palette. */
function doc(extra: Record<string, unknown> = {}): MascotDocument {
  return {
    format: FORMAT,
    version: VERSION,
    meta: { name: 'Themed' },
    view: { width: 100, height: 100 },
    palettes: {
      light: { body: '#ffd54a', trim: '#ff9a1f' },
      dark: { body: '#6b5a1e' },
    },
    root: {
      type: 'Node',
      id: 'root',
      children: [
        { type: 'Sphere', id: 'ball', props: { 'style.color': { color: 'body' } } },
        {
          type: 'Box',
          id: 'box',
          props: { 'style.color': '#ffffff' },
          faces: { top: { color: { color: 'trim' } } },
        },
      ],
    },
    ...extra,
  } as MascotDocument;
}

function issues(value: unknown): string[] {
  return validateDocument(value).map((issue) => `${issue.path}: ${issue.message}`);
}

describe('palettes', () => {
  it('builds with the first palette, or the one asked for over it', () => {
    const light = buildDocument(readDocument(doc()));
    const scene = new Scene(light.root);
    expect((scene.getById('ball') as Sphere).style.color).toBe('#ffd54a');
    expect((scene.getById('box') as Box).getFace('top').color).toBe('#ff9a1f');
    const dark = new Scene(buildDocument(readDocument(doc()), { palette: 'dark' }).root);
    expect((dark.getById('ball') as Sphere).style.color).toBe('#6b5a1e');
    // The dark palette has no trim: the first palette's is used.
    expect((dark.getById('box') as Box).getFace('top').color).toBe('#ff9a1f');
    expect(light.palettes).toEqual(['light', 'dark']);
  });

  it('switches on the fly, while the animation runs on', () => {
    const built = buildDocument(readDocument(doc()));
    const scene = new Scene(built.root);
    const animator = new Animator(scene, { rig: built.rig });
    built.animate(animator);
    const ball = scene.getById('ball') as Sphere;
    const before = scene.changeVersion;
    built.palette('dark');
    expect(ball.style.color).toBe('#6b5a1e');
    expect(scene.changeVersion).not.toBe(before);
    built.palette('light');
    expect(ball.style.color).toBe('#ffd54a');
    expect(() => built.palette('neon')).toThrow(
      /palette: no palette "neon" \(there are light, dark\)\./,
    );
  });

  it('checks the palettes and the roles colors refer to', () => {
    expect(issues(doc())).toEqual([]);
    expect(
      issues(
        doc({
          palettes: { light: { body: 'yellowish' }, dark: { glow: '#000' } },
          root: {
            type: 'Node',
            children: [
              { type: 'Sphere', props: { 'style.color': { color: 'skin' } } },
              { type: 'Sphere', props: { diameter: { color: 'body' } } },
              { type: 'Box', faces: { top: { color: { color: 'trim' } } } },
            ],
          },
        }),
      ),
    ).toEqual([
      'palettes.light.body: expected a CSS color, got "yellowish".',
      'palettes.dark.glow: the first palette has no role "glow": every role starts there.',
      'root.children[0].props.style.color.color: no palette role "skin" (there are body).',
      'root.children[1].props.diameter: expected a finite number, got {"color":"body"}.',
      'root.children[2].faces.top.color.color: no palette role "trim" (there are body).',
    ]);
    expect(issues(doc({ palettes: {} }))).toContain(
      'palettes: expected at least one palette: the first holds every role.',
    );
    // Without palettes, a role refers to nothing.
    const plain: Record<string, unknown> = { ...doc() };
    delete plain.palettes;
    expect(issues(plain)).toContain(
      'root.children[0].props.style.color.color: no palette role "body" (there are none).',
    );
  });

  it('recolors box faces and nullable colors on the fly, and goes back to the base for roles a palette leaves out', () => {
    const themed = doc({
      palettes: {
        light: { body: '#ffd54a', trim: '#ff9a1f' },
        brand: { body: '#112233', trim: '#00ff00' },
        dark: { body: '#6b5a1e' },
      },
    });
    const root = themed.root as { children: unknown[] };
    root.children.push({
      type: 'Cylinder',
      id: 'can',
      props: { frontFaceColor: { color: 'trim' } },
    });
    const built = buildDocument(readDocument(themed));
    const scene = new Scene(built.root);
    const box = scene.getById('box') as Box;
    const can = scene.getById('can') as unknown as { frontFaceColor: string | null };
    const before = scene.changeVersion;
    built.palette('brand');
    expect([box.getFace('top').color, box.style.color, box.getFace('front').color]).toEqual([
      '#00ff00',
      '#ffffff',
      null,
    ]);
    expect(can.frontFaceColor).toBe('#00ff00');
    expect(scene.changeVersion).not.toBe(before);
    // Dark names no trim: it is the base's again, not the brand's.
    built.palette('dark');
    expect([box.getFace('top').color, can.frontFaceColor]).toEqual(['#ff9a1f', '#ff9a1f']);
  });

  it('keeps a recolored animated color, given the animator', () => {
    const animated = doc({
      motions: {
        glow: {
          duration: 1,
          loop: 'loop',
          tracks: [
            {
              target: 'ball',
              property: 'style.color',
              keys: [
                { time: 0, value: '#000000' },
                { time: 1, value: '#000000' },
              ],
            },
          ],
        },
      },
      layers: [{ name: 'glow', play: 'glow', weight: 0 }],
    });
    const built = buildDocument(readDocument(animated));
    const scene = new Scene(built.root);
    const animator = new Animator(scene, { rig: built.rig });
    built.animate(animator);
    animator.update(0.1);
    const ball = scene.getById('ball') as Sphere;
    // The layer's weight is 0: the ball shows its rest color, which the animator owns.
    expect(ball.style.color).toBe('#ffd54a');
    built.palette('dark', animator);
    animator.update(0.1);
    expect(ball.style.color).toBe('#6b5a1e');
    // Without the animator the next frame writes the old rest color back.
    built.palette('light');
    animator.update(0.1);
    expect(ball.style.color).toBe('#6b5a1e');
  });

  it('takes palette colors through prefabs, in their definitions and instance props', () => {
    const withPrefab = doc({
      prefabs: {
        dot: { root: { type: 'Sphere', id: 'core', props: { 'style.color': { color: 'trim' } } } },
      },
      root: {
        type: 'Node',
        children: [
          { prefab: 'dot', id: 'a' },
          { prefab: 'dot', id: 'b', props: { 'style.color': { color: 'body' } } },
        ],
      },
    });
    const built = buildDocument(readDocument(withPrefab));
    const scene = new Scene(built.root);
    const color = (id: string) => (scene.getById(id) as Sphere).style.color;
    expect([color('a'), color('b')]).toEqual(['#ff9a1f', '#ffd54a']);
    built.palette('dark');
    expect([color('a'), color('b')]).toEqual(['#ff9a1f', '#6b5a1e']);
  });

  it('refuses number-like palette names and reports broken palettes once', () => {
    // JavaScript would put "2" first, making it the base.
    expect(
      issues(doc({ palettes: { light: { body: '#fff', trim: '#000' }, '2': { body: '#000' } } })),
    ).toContain(
      'palettes.2: a palette name cannot be a number: the order of palettes would change.',
    );
    // A broken base is one problem, not one more for every color that refers to it.
    expect(issues(doc({ palettes: { light: 'yellow' } }))).toEqual([
      'palettes.light: expected a palette of colors by role, got "yellow".',
    ]);
  });

  it('takes toon shadow colors from roles and the light from the camera', () => {
    const shaded = doc({
      camera: { props: { light: { x: 0, y: 0, z: 1 } } },
    });
    const root = shaded.root as { children: { props: Record<string, unknown> }[] };
    const props = (root.children[0] as { props: Record<string, unknown> }).props;
    props['style.shadowColor'] = { color: 'body' };
    props['style.highlightColor'] = { color: 'trim' };
    const built = buildDocument(readDocument(JSON.stringify(shaded)));
    const ball = new Scene(built.root).getById('ball') as Sphere;
    expect([ball.style.shadowColor, ball.style.highlightColor]).toEqual(['#ffd54a', '#ff9a1f']);
    expect(built.camera.light).toEqual({ x: 0, y: 0, z: 1 });
    built.palette('dark');
    // Dark names a body and no trim: the base's trim stays.
    expect([ball.style.shadowColor, ball.style.highlightColor]).toEqual(['#6b5a1e', '#ff9a1f']);
    expect(issues(doc({ camera: { props: { light: { x: 0, y: 0 } } } }))).toHaveLength(1);
  });
});

describe('blob shadows and outlines', () => {
  it('read with their defaults and write back what they read', () => {
    const shaded = doc({
      root: {
        type: 'Node',
        id: 'stage',
        children: [
          { type: 'BlobShadow', id: 'shadow', props: { width: 60 } },
          {
            type: 'Sphere',
            id: 'ball',
            props: { 'style.outline': 2, 'style.outlineColor': { color: 'trim' } },
          },
        ],
      },
    });
    const built = buildDocument(readDocument(JSON.stringify(shaded)));
    const scene = new Scene(built.root);
    const shadow = scene.getById('shadow') as BlobShadow;
    expect([shadow.width, shadow.squash, shadow.opacity, shadow.layer]).toEqual([
      60,
      1 / 3,
      0.2,
      -1,
    ]);
    expect((scene.getById('ball') as Sphere).style.outlineColor).toBe('#ff9a1f');
    const written = writeNode(built.root);
    const again = buildDocument(readDocument({ ...shaded, root: written }));
    const copy = new Scene(again.root).getById('shadow') as BlobShadow;
    expect([copy.width, copy.squash, copy.opacity, copy.sortMode, copy.layer]).toEqual([
      60,
      1 / 3,
      0.2,
      'layer',
      -1,
    ]);
  });
});
