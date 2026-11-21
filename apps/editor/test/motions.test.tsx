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
      // Its machine stays: it plays the reaction (hop) on its layer, once both are made.
      const { motions: _, layers: __, ...rest } = original;
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
    await change('Behavior 1 period', '2.8');
    await change('Behavior 1 phase', '0.25');
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
    expect(idle().behaviors[0]).toStrictEqual({
      kind: 'blink',
      target: { slot: 'body' },
      property: 'scale',
      from: { x: 1, y: 1, z: 1 },
      to: { x: 1, y: 1.05, z: 1 },
      duration: 0.15,
      minInterval: 2,
      maxInterval: 5,
    });
    await change('Behavior 1 seed', '7');
    expect(idle().behaviors[0]).toMatchObject({ seed: 7 });
    // A seed both kinds take stays; emptied, it goes.
    await change('Behavior 1 kind', 'noise');
    expect(idle().behaviors[0]).toMatchObject({ kind: 'noise', frequency: 1, seed: 7 });
    await change('Behavior 1 seed', '');
    expect(idle().behaviors[0]).not.toHaveProperty('seed');
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
    // An `at` another point has is refused: the engine takes strictly increasing points.
    await change('Point 1 at', '5');
    expect(problem.value).toMatch(/Another point is at 5/);
    // The field shows the stored value again.
    expect(control('Point 1 at').value).toBe('1');
    expect(state.value.document.motions?.mix).toMatchObject({ blend: [{ at: 1 }, { at: 5 }] });
    problem.value = null;
    // A point names no blend: not this one, nor another.
    await change('New motion kind', 'blend');
    await addNamed('New blend', 'other');
    await change('Motion', 'mix');
    const options = [...control<HTMLSelectElement>('Point 1 motion').options].map((o) => o.value);
    expect(options).not.toContain('mix');
    expect(options).not.toContain('other');
    await addNamed('Add layer', 'mood');
    await change('mood plays', 'motion:mix');
    expect(state.value.issues).toEqual([]);
  });

  it('edits a rotation behavior aimed at a node by id, and refuses an emptied color', async () => {
    await mount(readDocument(gloopDocument));
    await change('New motion kind', 'behaviors');
    await addNamed('New behaviors', 'turn');
    await press('Add behavior');
    await change('Behavior 1 target', 'id:blob');
    await change('Behavior 1 property', 'rotation');
    const turn = () =>
      (state.value.document.motions?.turn as BehaviorSet | undefined)?.behaviors[0];
    expect(turn()).toMatchObject({ target: 'blob', from: { x: 0, y: 0, z: 0, w: 1 } });
    await change('Behavior 1 to z', '90');
    const to = turn()?.to as Record<'x' | 'y' | 'z' | 'w', number>;
    expect(to.z).toBeCloseTo(Math.SQRT1_2);
    expect(to.w).toBeCloseTo(Math.SQRT1_2);
    // A color the property cannot leave out: emptied, it stays.
    await change('Behavior 1 property', 'style.color');
    const color = turn()?.to;
    await change('Behavior 1 to', '');
    expect(turn()?.to).toBe(color);
    expect(state.value.issues).toEqual([]);
  });

  it('shows malformed behaviors, points and library motions without breaking', async () => {
    const base = newDocument('blob');
    await mount({
      ...base,
      motions: {
        odd: {
          behaviors: [
            { kind: 'oscillate', property: 'opacity', from: 1, to: 0, period: 1 },
            { kind: 'constructor', target: { slot: 'gone' }, property: 'opacity', from: 1, to: 0 },
          ],
        },
        mix: { input: 'x', blend: [null, { at: 'soon', motion: 7 }] },
        far: { library: 'nope' },
      },
    } as unknown as MascotDocument);
    await change('Motion', 'odd');
    expect(document.body.textContent).toMatch(/Behavior 1 is not a behavior/);
    expect(control<HTMLSelectElement>('Behavior 2 kind').value).toBe('constructor');
    expect(control<HTMLSelectElement>('Behavior 2 target').value).toBe('slot:gone');
    expect(document.body.textContent).toMatch(/The document has issues: its ends/);
    await press('Remove Behavior 1');
    expect(state.value.document.motions?.odd).toMatchObject({
      behaviors: [{ kind: 'constructor' }],
    });
    await change('Motion', 'mix');
    expect(document.body.textContent).toMatch(/Point 1 is not a point/);
    await press('Remove Point 1');
    expect(state.value.document.motions?.mix).toEqual({
      input: 'x',
      blend: [{ at: 'soon', motion: 7 }],
    });
    await change('Motion', 'far');
    expect(control<HTMLSelectElement>('Library motion').value).toBe('nope');
  });

  it('marks the library motions the rig cannot play, and starts from one it can', async () => {
    const gloop = readDocument(gloopDocument);
    const { motions: _, layers: __, machines: ___, ...rest } = gloop;
    await mount(rest);
    await change('New motion kind', 'library');
    await addNamed('New library motion', 'first');
    const options = [...control<HTMLSelectElement>('Library motion').options].map(
      (option) => option.textContent,
    );
    // Gloop is a blob: no tail to wag.
    expect(options.find((option) => option?.startsWith('wag'))).toMatch(/needs the slots tail/);
    const chosen = (state.value.document.motions?.first as { library: string } | undefined)
      ?.library;
    expect(options).toContain(chosen);
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

  it("starts a behavior's ends at a prefab node's rest value, as the document builds", async () => {
    const gloop = readDocument(gloopDocument);
    await mount(gloop);
    await change('New motion kind', 'behaviors');
    await addNamed('New behaviors', 'look');
    await press('Add behavior');
    // A node the eye prefab makes, away from its instance's origin.
    const positionOf = (id: string) => {
      const node = state.value.scene?.built.root.findById(id);
      return { x: node?.position.x, y: node?.position.y, z: node?.position.z };
    };
    const made = ['eye-left-white', 'eye-left-iris', 'eye-left-pupil', 'eye-left-highlight'].find(
      (id) => JSON.stringify(positionOf(id)) !== JSON.stringify({ x: 0, y: 0, z: 0 }),
    );
    if (!made) throw new Error('no made node away from its origin');
    await change('Behavior 1 target', `id:${made}`);
    await change('Behavior 1 property', 'position');
    const behavior = (state.value.document.motions?.look as BehaviorSet | undefined)?.behaviors[0];
    const rest = positionOf(made);
    expect(behavior?.from).toEqual(rest);
    expect(behavior?.to).toEqual(rest);
  });

  it('closes a motion form when another document opens', async () => {
    await mount(readDocument(gloopDocument));
    await change('Motion', 'breathe');
    expect(document.querySelector('[aria-label="Motion breathe"]')).not.toBeNull();
    openDocument(readDocument(misoDocument), null);
    await settle();
    expect(document.querySelector('[aria-label="Motion breathe"]')).toBeNull();
  });
});
