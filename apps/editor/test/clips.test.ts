import type { Clip } from '@mascotte/engine';
import { readDocument } from '@mascotte/format';
import { pipDocument } from '@mascotte/reference';
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
import { EditorDocument } from '../src/model/editor-document.ts';

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
});
