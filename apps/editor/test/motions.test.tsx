import type { BehaviorSet } from '@mascotte/engine';
import { type MascotDocument, readDocument } from '@mascotte/format';
import { gloopDocument, misoDocument, pipDocument } from '@mascotte/reference';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { offeredDraft, openDocument, problem, state } from '../src/store.ts';

let host: HTMLDivElement | null = null;

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
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

/** The control labelled `label`: by `aria-label`, or the text a label starts with. */
function control<T extends HTMLElement = HTMLInputElement>(label: string, within = 'body'): T {
  const scope = document.querySelector(within);
  const found =
    scope?.querySelector<T>(`[aria-label="${label}"]`) ??
    ([...(scope?.querySelectorAll('label') ?? [])]
      .find((each) => each.firstChild?.textContent?.trim() === label)
      ?.querySelector<T>('input, select') as T | undefined);
  if (!found) throw new Error(`no control ${label} in ${within}`);
  return found;
}

async function change(label: string, value: string, within?: string): Promise<void> {
  const field = control<HTMLInputElement | HTMLSelectElement>(label, within);
  field.value = value;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

async function press(text: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (each) => each.getAttribute('aria-label') === text || each.textContent === text,
  );
  if (!button) throw new Error(`no button ${text}`);
  button.click();
  await settle();
}

/** Types a name into the row `label` and presses its button. */
async function addNamed(label: string, name: string): Promise<void> {
  const input = control(`${label} name`);
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  await press(label);
}

describe('motion forms', () => {
  for (const [title, make] of [
    ['Gloop', () => readDocument(gloopDocument)],
    ['Miso', () => readDocument(misoDocument)],
  ] as const) {
    it(`sets up ${title}'s idle and reactions on their layers`, async () => {
      const original = make();
      const { motions: _, layers: __, machines: ___, ...rest } = original;
      await mount(rest);
      // Its motions, from the library.
      await change('New motion kind', 'library');
      for (const [name, motion] of Object.entries(original.motions ?? {})) {
        await addNamed('New library motion', name);
        await change('Library motion', (motion as { library: string }).library);
      }
      expect(state.value.document.motions).toEqual(original.motions);
      // Its layers, each with its mode and what it plays.
      for (const layer of original.layers ?? []) {
        await addNamed('Add layer', layer.name);
        if (layer.mode !== undefined) await change(`${layer.name} mode`, layer.mode);
        if (typeof layer.play === 'string')
          await change(`${layer.name} plays`, `motion:${layer.play}`);
      }
      expect(state.value.document.layers).toEqual(original.layers);
      expect(state.value.issues).toEqual([]);
      expect(problem.value).toBeNull();
    });
  }

  it('makes a behavior set: kinds, targets, properties, ends and numbers', async () => {
    await mount(newDocument('blob'));
    await change('New motion kind', 'behaviors');
    await addNamed('New behaviors', 'idle');
    await press('Add behavior');
    const idle = () => state.value.document.motions?.idle as BehaviorSet;
    expect(idle().behaviors).toEqual([
      {
        kind: 'oscillate',
        target: { slot: 'root' },
        property: 'opacity',
        from: 1,
        to: 1,
        period: 1,
      },
    ]);
    await change('Behavior 1 target', 'slot:body');
    await change('Behavior 1 property', 'scale');
    await change('Behavior 1 to y', '1.05');
    await change('period', '2.8');
    await change('phase', '0.25');
    expect(idle().behaviors[0]).toEqual({
      kind: 'oscillate',
      target: { slot: 'body' },
      property: 'scale',
      from: { x: 1, y: 1, z: 1 },
      to: { x: 1, y: 1.05, z: 1 },
      period: 2.8,
      phase: 0.25,
    });
    // Another kind takes its own numbers, and keeps the ends.
    await change('Behavior 1 kind', 'blink');
    expect(idle().behaviors[0]).toEqual({
      kind: 'blink',
      target: { slot: 'body' },
      property: 'scale',
      from: { x: 1, y: 1, z: 1 },
      to: { x: 1, y: 1.05, z: 1 },
      duration: 0.15,
      minInterval: 2,
      maxInterval: 5,
    });
    await change('seed', '7');
    expect(idle().behaviors[0]).toMatchObject({ seed: 7 });
    // On an additive layer, it plays: the engine takes it.
    await addNamed('Add layer', 'idle');
    await change('idle mode', 'additive');
    await change('idle plays', 'motion:idle');
    expect(state.value.issues).toEqual([]);
    await press('Remove Behavior 1');
    expect(idle().behaviors).toEqual([]);
  });

  it('makes a blend of clips by a number input', async () => {
    const pip = readDocument(pipDocument());
    const [machine, ...others] = pip.machines ?? [];
    await mount({
      ...pip,
      machines: [
        { ...machine, inputs: [...(machine?.inputs ?? []), { name: 'mood', type: 'number' }] },
        ...others,
      ] as MascotDocument['machines'],
    } as MascotDocument);
    await change('New motion kind', 'blend');
    await addNamed('New blend', 'mix');
    expect(state.value.document.motions?.mix).toEqual({ input: 'mood', blend: [] });
    await press('Add point');
    await press('Add point');
    await change('Point 2 motion', 'happy');
    await change('Point 1 at', '5');
    // Kept in increasing order of `at`: the point moved to 5 is now the second.
    expect(state.value.document.motions?.mix).toEqual({
      input: 'mood',
      blend: [
        { at: 1, motion: 'happy' },
        { at: 5, motion: 'calm' },
      ],
    });
    await addNamed('Add layer', 'mood');
    await change('mood plays', 'motion:mix');
    expect(state.value.issues).toEqual([]);
  });

  it('opens a motion in its form and closes it when the motion goes', async () => {
    await mount(readDocument(gloopDocument));
    await change('Motion', 'breathe');
    expect(document.querySelector('[aria-label="Motion breathe"]')).not.toBeNull();
    expect(document.body.textContent).toMatch(/For additive layers/);
    await press('Remove motion breathe');
    expect(state.value.document.motions?.breathe).toBeUndefined();
    expect(document.querySelector('[aria-label="Motion breathe"]')).toBeNull();
  });
});
