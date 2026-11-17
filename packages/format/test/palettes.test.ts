import { Animator, type Box, Scene, type Sphere } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  FORMAT,
  type MascotDocument,
  readDocument,
  VERSION,
  validateDocument,
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
    const { palettes, ...plain } = doc();
    expect(palettes).toBeDefined();
    expect(issues(plain)).toContain(
      'root.children[0].props.style.color.color: no palette role "body" (there are none).',
    );
  });
});
