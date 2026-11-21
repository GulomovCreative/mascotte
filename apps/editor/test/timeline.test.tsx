import { bindClip, type Clip, type Node, Scene } from '@mascotte/engine';
import {
  buildDocument,
  type MascotDocument,
  type NodeDocument,
  readDocument,
} from '@mascotte/format';
import { euler, quat } from '@mascotte/math';
import { pipDocument } from '@mascotte/reference';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { autoKey } from '../src/panels/timeline.tsx';
import { editor, offeredDraft, openDocument, problem, state } from '../src/store.ts';

let host: HTMLDivElement | null = null;

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
  autoKey.value = false;
  offeredDraft.value = null;
  problem.value = null;
  openDocument(newDocument('blob'), null);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(document: MascotDocument): Promise<void> {
  openDocument(document, null);
  host = window.document.createElement('div');
  window.document.body.append(host);
  render(<App />, host);
  await settle();
}

function control<T extends HTMLElement = HTMLInputElement>(label: string, within = 'body'): T {
  const found = document.querySelector(within)?.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no control ${label} in ${within}`);
  return found;
}

async function change(label: string, value: string, within?: string): Promise<void> {
  const field = control<HTMLInputElement | HTMLSelectElement>(label, within);
  field.value = value;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

async function click(label: string, within?: string): Promise<void> {
  control(label, within).click();
  await settle();
}

/** Types a name into the row `label` and presses its button. */
async function addNamed(label: string, name: string): Promise<void> {
  const input = control(`${label} name`);
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const button = [...document.querySelectorAll('button')].find(
    (each) => each.textContent === label,
  );
  button?.click();
  await settle();
}

/** The path of the first node with `id` in the open document. */
function pathOf(id: string): number[] {
  const walk = (node: NodeDocument, path: number[]): number[] | null => {
    if (node.id === id) return path;
    for (const [i, child] of (node.children ?? []).entries()) {
      const found = walk(child, [...path, i]);
      if (found) return found;
    }
    return null;
  };
  const found = walk(state.value.document.root, []);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

/** Expects `actual` to be `expected`, numbers to 4 places. */
function expectClose(actual: unknown, expected: unknown, at = 'value'): void {
  if (typeof expected === 'number') {
    expect(actual, at).toBeCloseTo(expected, 4);
  } else if (typeof expected === 'object' && expected !== null) {
    expect(typeof actual, at).toBe('object');
    const keys = Object.keys(expected);
    expect(Object.keys(actual as object).sort(), at).toEqual(keys.sort());
    for (const key of keys) {
      expectClose(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        `${at}.${key}`,
      );
    }
  } else expect(actual, at).toEqual(expected);
}

const EMOTIONS = ['calm', 'happy', 'surprised'] as const;

/** Pip without its emotion clips and its machines (which play them): what the test makes again. */
function pipWithout(): MascotDocument {
  const pip = readDocument(pipDocument());
  const motions = Object.fromEntries(
    Object.entries(pip.motions ?? {}).filter(
      ([name]) => !(EMOTIONS as readonly string[]).includes(name),
    ),
  );
  const { machines: _, ...rest } = pip;
  return { ...rest, motions };
}

/** Makes the key `value` of `property` at the playhead through the inspector, with auto-key on. */
async function keyThrough(property: string, value: unknown): Promise<void> {
  if (property === 'rotation') {
    const q = value as { x: number; y: number; z: number; w: number };
    const angles = quat.toEuler(euler.create(), q, 'XYZ');
    for (const axis of ['x', 'y', 'z'] as const) {
      await change(`rotation ${axis}`, String((angles[axis] * 180) / Math.PI));
    }
  } else if (property === 'scale') {
    const v = value as Record<'x' | 'y' | 'z', number>;
    for (const axis of ['x', 'y', 'z'] as const) await change(`scale ${axis}`, String(v[axis]));
  } else if (property === 'visible') {
    // A click keys the opposite of what it shows: twice when it shows the value wanted.
    if (control('visible').checked === value) await click('visible');
    await click('visible');
  } else throw new Error(`no way to key ${property} in this test`);
}

describe('timeline', () => {
  it("makes Pip's calm, happy and surprised clips, and plays them", async () => {
    const pip = readDocument(pipDocument());
    await mount(pipWithout());
    const slots = state.value.document.rig?.slots ?? {};
    for (const name of EMOTIONS) {
      const original = pip.motions?.[name] as Clip;
      await addNamed('New clip', name);
      await change('Duration', String(original.duration));
      await change('Loop', original.loop);
      await click('Auto-key');
      for (const track of original.tracks) {
        const slot = (track.target as { slot: string }).slot;
        editor.value.select(pathOf(slots[slot] as string));
        await settle();
        for (const key of track.keys) {
          editor.value.seek(key.time);
          await settle();
          await keyThrough(track.property, key.value);
          if (key.easing !== undefined) {
            await click(`Key ${key.time} s`, `[aria-label="slot ${slot} ${track.property}"]`);
            await change('Key easing', key.easing as string);
          }
        }
      }
      expect(problem.value).toBeNull();
      expectClose(state.value.document.motions?.[name], original, name);
      await click('Auto-key');
    }
    expect(state.value.issues).toEqual([]);
    // Auto-key keyed the clips; the rest pose is as it was.
    expectClose(state.value.document.root, pipWithout().root, 'root');

    // Played: the happy wings, sought anywhere, are where Pip's own clip puts them.
    await change('Motion', 'happy');
    const reference = buildDocument(pip);
    const binding = bindClip(pip.motions?.happy as Clip, new Scene(reference.root), {
      rig: reference.rig,
    });
    const wing = slots['wing.L'] as string;
    // A rotation's fields are getters: copied one by one, not spread.
    const turn = (root: Node) => {
      const node = root.findById(wing);
      if (!node) throw new Error(`no node ${wing}`);
      const { x, y, z, w } = node.rotation;
      return { x, y, z, w };
    };
    const rest = turn(buildDocument(pipWithout()).root);
    for (const time of [0, 0.05, 0.13, 0.2]) {
      const range = control('Playhead');
      range.value = String(time);
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
      binding.apply(time);
      const shown = state.value.scene?.built.root;
      if (!shown) throw new Error('no scene');
      expect(turn(shown), `wing at ${time}`).not.toEqual(rest);
      expectClose(turn(shown), turn(reference.root), `wing at ${time}`);
    }
    // And it plays on: the playhead moves while playing, and stays once paused.
    await click('Play');
    await new Promise((resolve) => setTimeout(resolve, 120));
    const moved = state.value.preview.solo?.time ?? 0;
    expect(moved).toBeGreaterThan(0);
    await click('Pause');
    const stopped = state.value.preview.solo?.time;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(state.value.preview.solo?.time).toBe(stopped);
  });

  it('keys the selected node with what it shows, and edits keys', async () => {
    await mount(newDocument('blob'));
    await addNamed('New clip', 'bob');
    editor.value.select(pathOf('body'));
    await settle();
    await change('Property to key', 'position');
    const key = [...document.querySelectorAll('button')].find(
      (each) => each.textContent === 'Key this',
    );
    key?.click();
    await settle();
    const clip = () => state.value.document.motions?.bob as Clip;
    // `body` fills the rig's body slot: its track names the slot.
    expect(clip().tracks).toEqual([
      {
        target: { slot: 'body' },
        property: 'position',
        keys: [{ time: 0, value: { x: 0, y: -30, z: 0 } }],
      },
    ]);
    await click('Key 0 s');
    await change('Key time', '0.5');
    await change('Key easing', 'sineInOut');
    expect(clip().tracks[0]?.keys).toEqual([
      { time: 0.5, value: { x: 0, y: -30, z: 0 }, easing: 'sineInOut' },
    ]);
    editor.value.seek(0.25);
    await settle();
    const copy = [...document.querySelectorAll('button')].find(
      (each) => each.textContent === 'Copy to playhead',
    );
    copy?.click();
    await settle();
    expect(clip().tracks[0]?.keys.map((each) => each.time)).toEqual([0.25, 0.5]);
    // By id rather than the slot, and back.
    const byId = [...document.querySelectorAll('button')].find(
      (each) => each.textContent === 'by id',
    );
    byId?.click();
    await settle();
    expect(clip().tracks[0]?.target).toBe('body');
    const remove = [...document.querySelectorAll('button')].find(
      (each) => each.textContent === 'Delete key',
    );
    remove?.click();
    await settle();
    expect(clip().tracks[0]?.keys).toHaveLength(1);
    await click('Remove track body position');
    expect(clip().tracks).toEqual([]);
    expect(state.value.issues).toEqual([]);
  });

  it('edits the layers: their order, mode, weight, mask and motion', async () => {
    await mount(readDocument(pipDocument()));
    await change('tilt mode', 'override');
    await change('blink weight', '0.5');
    await change('blink mask', '');
    await change('chirp plays', '');
    await click('Move blink up');
    await addNamed('Add layer', 'extra');
    const layers = state.value.document.layers ?? [];
    expect(layers.map((layer) => layer.name)).toEqual([
      'emotion',
      'idle',
      'tilt',
      'blink',
      'chirp',
      'extra',
    ]);
    expect(layers[2]).toEqual({ name: 'tilt', mode: 'override', play: 'tilt' });
    expect(layers[3]).toEqual({ name: 'blink', play: 'blink', weight: 0.5 });
    expect(layers[4]).toEqual({ name: 'chirp', mode: 'additive' });
    expect(state.value.issues).toEqual([]);
    await click('Remove layer extra');
    expect(state.value.document.layers).toHaveLength(5);
  });

  it('plays a clip once to its end, and again from the start', async () => {
    await mount(readDocument(pipDocument()));
    await change('Motion', 'surprised');
    editor.value.seek(0.85);
    await settle();
    await click('Play');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(state.value.preview.solo?.time).toBe(0.9);
    expect(control('Play').getAttribute('aria-label')).toBe('Play');
    await click('Play');
    await settle();
    expect(state.value.preview.solo?.time ?? 1).toBeLessThan(0.9);
    await click('Pause');
  });

  it('keeps the key selected through edits that move the others', async () => {
    await mount(newDocument('blob'));
    await addNamed('New clip', 'bob');
    editor.value.select(pathOf('body'));
    await settle();
    await change('Property to key', 'opacity');
    const keyThis = () =>
      [...document.querySelectorAll('button')]
        .find((each) => each.textContent === 'Key this')
        ?.click();
    for (const time of [0, 0.5]) {
      editor.value.seek(time);
      await settle();
      keyThis();
      await settle();
    }
    const clip = () => state.value.document.motions?.bob as Clip;
    // The first key moved past the second, then eased: the moved one gets the easing.
    await click('Key 0 s');
    await change('Key time', '0.8');
    await change('Key easing', 'quadIn');
    expect(clip().tracks[0]?.keys.map((key) => [key.time, key.easing])).toEqual([
      [0.5, undefined],
      [0.8, 'quadIn'],
    ]);
    // A key added before it leaves it selected.
    editor.value.seek(0.1);
    await settle();
    keyThis();
    await settle();
    await change('Key easing', 'quadOut');
    expect(clip().tracks[0]?.keys.map((key) => [key.time, key.easing])).toEqual([
      [0.1, undefined],
      [0.5, undefined],
      [0.8, 'quadOut'],
    ]);
  });

  it('keys a track that names the node by id rather than add one by its slot', async () => {
    await mount(newDocument('blob'));
    await addNamed('New clip', 'bob');
    editor.value.select(pathOf('body'));
    await settle();
    await change('Property to key', 'opacity');
    const keyThis = () =>
      [...document.querySelectorAll('button')]
        .find((each) => each.textContent === 'Key this')
        ?.click();
    keyThis();
    await settle();
    [...document.querySelectorAll('button')].find((each) => each.textContent === 'by id')?.click();
    await settle();
    editor.value.seek(0.5);
    await settle();
    keyThis();
    await settle();
    const clip = state.value.document.motions?.bob as Clip;
    expect(clip.tracks).toHaveLength(1);
    expect(clip.tracks[0]?.target).toBe('body');
    expect(clip.tracks[0]?.keys.map((key) => key.time)).toEqual([0, 0.5]);
  });

  it('refuses what auto-key cannot key, and leaves the rest values', async () => {
    const base = newDocument('blob');
    await mount({
      ...base,
      root: { ...base.root, children: [...(base.root.children ?? []), { type: 'Sphere' }] },
    });
    await addNamed('New clip', 'bob');
    await click('Auto-key');
    const rest = state.value.document.root;
    // A node with no id cannot be keyed.
    editor.value.select([base.root.children?.length ?? 0]);
    await settle();
    await change('opacity', '0.5');
    expect(problem.value).toMatch(/id/);
    // Clearing or binding with auto-key on is refused; reset is off.
    problem.value = null;
    editor.value.select(pathOf('body'));
    await settle();
    await change('opacity', '');
    expect(problem.value).toMatch(/Auto-key/);
    expect(control<HTMLButtonElement>('Reset opacity').disabled).toBe(true);
    expect(state.value.document.root).toBe(rest);
    expect(state.value.document.motions?.bob).toEqual({ duration: 1, loop: 'once', tracks: [] });
  });

  it('shows a malformed clip and malformed layers without breaking', async () => {
    const base = newDocument('blob');
    await mount({
      ...base,
      motions: { broken: { duration: 1, loop: 'bounce', tracks: [{ target: null, keys: {} }] } },
      layers: [null],
    } as unknown as MascotDocument);
    const option = [...control<HTMLSelectElement>('Motion').options].find(
      (each) => each.value === 'broken',
    );
    expect(option?.textContent).toMatch(/clip with issues/);
    expect(option?.disabled).toBe(true);
    expect(document.body.textContent).toMatch(/The layers are malformed/);
    const remove = [...document.querySelectorAll('button')].find(
      (each) => each.textContent === 'Remove the layers',
    );
    remove?.click();
    await settle();
    expect(state.value.document.layers).toBeUndefined();
  });
});
