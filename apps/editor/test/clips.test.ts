import type { Clip } from '@mascotte/engine';
import { readDocument } from '@mascotte/format';
import { misoDocument, pipDocument } from '@mascotte/reference';
import { describe, expect, it } from 'vitest';
import {
  clipTimeOf,
  copiedKey,
  eased,
  keyed,
  lasting,
  retargeted,
  retimed,
  unkeyed,
  untracked,
} from '../src/model/clips.ts';
import { setDocumentField } from '../src/model/commands.ts';
import { EditorDocument, isClip } from '../src/model/editor-document.ts';

const empty: Clip = { duration: 1, loop: 'once', tracks: [] };
const slot = { slot: 'head' };

describe('clip edits', () => {
  it('keys a track, in time order, replacing a key at the same time but keeping its easing', () => {
    let clip = keyed(empty, slot, 'opacity', 0.5, 0.5);
    clip = keyed(clip, slot, 'opacity', 0.2, 0.2);
    clip = eased(clip, 0, 1, 'sineIn');
    clip = keyed(clip, slot, 'opacity', 0.5, 0.9);
    clip = keyed(clip, 'eye', 'opacity', 0, 1);
    expect(clip.tracks).toEqual([
      {
        target: slot,
        property: 'opacity',
        keys: [
          { time: 0.2, value: 0.2 },
          { time: 0.5, value: 0.9, easing: 'sineIn' },
        ],
      },
      { target: 'eye', property: 'opacity', keys: [{ time: 0, value: 1 }] },
    ]);
    expect(eased(clip, 0, 1, undefined).tracks[0]?.keys[1]).toEqual({ time: 0.5, value: 0.9 });
  });

  it('replaces one key of a step, keeping the other', () => {
    const step: Clip = {
      duration: 1,
      loop: 'once',
      tracks: [
        {
          target: slot,
          property: 'opacity',
          keys: [
            { time: 0.5, value: 0 },
            { time: 0.5, value: 1 },
          ],
        },
      ],
    };
    expect(keyed(step, slot, 'opacity', 0.5, 0.3).tracks[0]?.keys).toEqual([
      { time: 0.5, value: 0.3 },
      { time: 0.5, value: 1 },
    ]);
  });

  it('keeps times within the clip, to the millisecond', () => {
    expect(clipTimeOf(empty, 2)).toBe(1);
    expect(clipTimeOf(empty, -1)).toBe(0);
    expect(clipTimeOf(empty, 0.12345)).toBe(0.123);
  });

  it('moves, copies and removes keys, and drops a track with none', () => {
    let clip = keyed(keyed(empty, slot, 'opacity', 0, 0), slot, 'opacity', 1, 1);
    clip = retimed(clip, 0, 0, 0.6);
    expect(clip.tracks[0]?.keys.map((key) => key.time)).toEqual([0.6, 1]);
    // Moved onto another key, it replaces it.
    expect(retimed(clip, 0, 0, 1).tracks[0]?.keys).toEqual([{ time: 1, value: 0 }]);
    clip = copiedKey(clip, 0, 1, 0.3);
    expect(clip.tracks[0]?.keys.map((key) => [key.time, key.value])).toEqual([
      [0.3, 1],
      [0.6, 0],
      [1, 1],
    ]);
    clip = unkeyed(unkeyed(unkeyed(clip, 0, 0), 0, 0), 0, 0);
    expect(clip.tracks).toEqual([]);
    expect(() => unkeyed(clip, 0, 0)).toThrow(/no track/);
  });

  it('keys the track of a node however it names it, and refuses a twin track', () => {
    const slots = { head: 'skull' };
    const byId = keyed(empty, 'skull', 'opacity', 0, 1);
    const both = keyed(byId, slot, 'opacity', 0.5, 0, slots);
    expect(both.tracks).toHaveLength(1);
    expect(both.tracks[0]?.target).toBe('skull');
    const twin = keyed(byId, slot, 'scale', 0, { x: 1, y: 1, z: 1 });
    expect(() => retargeted(keyed(twin, slot, 'opacity', 0, 1), 1, slot)).not.toThrow();
    const clash = keyed(keyed(empty, 'skull', 'opacity', 0, 1), slot, 'opacity', 0, 1);
    expect(clash.tracks).toHaveLength(2);
    expect(() => retargeted(clash, 0, slot)).toThrow(/Another track/);
    expect(() => lasting(empty, Number.NaN)).toThrow(RangeError);
    // A time rounded up past a short clip's end stays within it.
    expect(clipTimeOf({ ...empty, duration: 0.0015 }, 1)).toBe(0.0015);
  });

  it('retargets and removes tracks, and shortens a clip with its keys', () => {
    const clip = keyed(keyed(empty, slot, 'opacity', 0.9, 1), slot, 'opacity', 0.1, 0);
    expect(retargeted(clip, 0, 'skull').tracks[0]?.target).toBe('skull');
    expect(untracked(clip, 0).tracks).toEqual([]);
    expect(lasting(clip, 0.5)).toEqual({
      duration: 0.5,
      loop: 'once',
      tracks: [{ target: slot, property: 'opacity', keys: [{ time: 0.1, value: 0 }] }],
    });
    expect(lasting(clip, 0).tracks).toEqual([]);
  });
});

describe('solo preview', () => {
  it('shows a clip alone at a time, sought without a rebuild, and drops it with the clip', () => {
    const editor = new EditorDocument(readDocument(pipDocument()));
    const wing = () => editor.state.scene?.built.root.findById('wing-left')?.rotation.z;
    const playing = wing();
    editor.setPreview({ solo: { motion: 'happy', time: 0 } });
    const scene = editor.state.scene;
    expect(scene?.solo).not.toBeNull();
    const start = wing();
    editor.seek(0.12);
    expect(editor.state.scene).toBe(scene);
    expect(editor.state.preview.solo).toEqual({ motion: 'happy', time: 0.12 });
    expect(wing()).not.toBe(start);
    // A behavior set is no clip: nothing is shown solo.
    editor.setPreview({ solo: { motion: 'idle', time: 0 } });
    expect(editor.state.preview).toEqual({});
    expect(editor.state.scene?.solo).toBeNull();
    editor.setPreview({ solo: { motion: 'happy', time: 0 } });
    editor.execute(setDocumentField(['motions', 'happy'], undefined));
    expect(editor.state.preview).toEqual({});
    editor.undo();
    expect(editor.state.preview.solo?.motion).toBe('happy');
    editor.setPreview({});
    expect(wing()).toBe(playing);
  });

  it("reports a clip the engine refuses as the clip's issue", () => {
    const editor = new EditorDocument(readDocument(pipDocument()));
    editor.execute(
      setDocumentField(['motions', 'broken'], {
        duration: 1,
        loop: 'once',
        tracks: [{ target: 'nobody', property: 'opacity', keys: [{ time: 0, value: 1 }] }],
      }),
    );
    expect(editor.state.issues).toEqual([]);
    editor.setPreview({ solo: { motion: 'broken', time: 0 } });
    expect(editor.state.issues[0]?.path).toBe('motions.broken');
    // The scene shown before stays.
    expect(editor.state.scene?.solo).toBeNull();
  });

  it('seeks without a step, to the same pose however it is reached', () => {
    const editor = new EditorDocument(readDocument(pipDocument()));
    const wing = () => {
      const { x, y, z, w } = editor.state.scene?.built.root.findById('wing-left')?.rotation ?? {};
      return { x, y, z, w };
    };
    editor.setPreview({ solo: { motion: 'happy', time: 0.2 } });
    const direct = wing();
    editor.seek(0.05);
    editor.seek(0.2);
    expect(wing()).toEqual(direct);
    expect(editor.state.canUndo).toBe(false);
    expect(() => editor.seek(Number.NaN)).toThrow(RangeError);
    expect(() => editor.seek(-1)).toThrow(RangeError);
    expect(editor.state.preview.solo?.time).toBe(0.2);
  });

  it('keeps the palette previewed with a clip, and leaves what the clip does not set at rest', () => {
    const miso = readDocument(misoDocument);
    const editor = new EditorDocument(miso);
    editor.execute(
      setDocumentField(['motions', 'fade'], {
        duration: 1,
        loop: 'once',
        tracks: [{ target: 'tail', property: 'opacity', keys: [{ time: 0, value: 0.5 }] }],
      }),
    );
    const node = (id: string) => editor.state.scene?.built.root.findById(id);
    const style = (id: string) => (node(id) as unknown as { style: { color: string } }).style.color;
    editor.setPreview({ palette: 'smoke', solo: { motion: 'fade', time: 0 } });
    expect(editor.state.preview).toEqual({ palette: 'smoke', solo: { motion: 'fade', time: 0 } });
    expect(style('skull')).toBe(miso.palettes?.smoke?.fur);
    expect(node('tail')?.opacity).toBe(0.5);
    // Miso's idle layers breathe and sway it: solo, its body is at rest.
    const body = node('body');
    expect([body?.scale.x, body?.scale.y, body?.scale.z]).toEqual([1, 1, 1]);
  });

  it('marks the last scene stale when the clip previewed is refused, and does not play it', () => {
    const editor = new EditorDocument(readDocument(pipDocument()));
    editor.execute(
      setDocumentField(['motions', 'broken'], {
        duration: 1,
        loop: 'once',
        tracks: [{ target: 'nobody', property: 'opacity', keys: [{ time: 0, value: 1 }] }],
      }),
    );
    editor.setPreview({ solo: { motion: 'happy', time: 0 } });
    const happy = editor.state.scene;
    editor.setPreview({ solo: { motion: 'broken', time: 0 } });
    expect(editor.state.issues[0]?.path).toBe('motions.broken');
    expect(editor.state.scene).toBe(happy);
    expect(editor.state.stale).toBe(true);
    // Seeking tries the clip again rather than drive the happy one.
    const time = happy?.solo?.time;
    editor.seek(0.1);
    expect(happy?.solo?.time).toBe(time);
  });

  it('tells a clip the editor can open from a malformed one', () => {
    expect(isClip({ duration: 1, loop: 'once', tracks: [] })).toBe(true);
    for (const bad of [
      { duration: 1, loop: 'bounce', tracks: [] },
      { duration: -1, loop: 'once', tracks: [] },
      { duration: 1, loop: 'once', tracks: [null] },
      { duration: 1, loop: 'once', tracks: [{ target: null, property: 'x', keys: [] }] },
      { duration: 1, loop: 'once', tracks: [{ target: 'a', property: 'x', keys: {} }] },
      { duration: 1, loop: 'once', tracks: [{ target: 'a', property: 'x', keys: [null] }] },
    ]) {
      expect(isClip(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('reports a clip the editor cannot open, though no layer plays it', () => {
    const editor = new EditorDocument(readDocument(pipDocument()));
    editor.execute(
      setDocumentField(['motions', 'odd'], { duration: 1, tracks: [] } as unknown as Clip),
    );
    expect(editor.state.issues).toEqual([
      { path: 'motions.odd', message: 'the clip: its loop is not one of once, loop, pingpong.' },
    ]);
  });
});
