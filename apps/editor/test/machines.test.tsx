import { type MachineDocument, type MascotDocument, readDocument } from '@mascotte/format';
import { gloopDocument, misoDocument, pipDocument } from '@mascotte/reference';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App, bottomTab } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { previewing } from '../src/panels/machines.tsx';
import { offeredDraft, openDocument, problem, state } from '../src/store.ts';

let host: HTMLDivElement | null = null;

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
  previewing.value = false;
  bottomTab.value = 'Timeline';
  offeredDraft.value = null;
  problem.value = null;
  openDocument(newDocument('blob'), null);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(document: MascotDocument): Promise<void> {
  openDocument(document, null);
  bottomTab.value = 'State machines';
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

async function addNamed(label: string, name: string): Promise<void> {
  const input = control(`${label} name`);
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  await press(label);
}

/** Makes `original` through the editor: its name, layer, inputs, states and transitions. */
async function make(original: MachineDocument): Promise<void> {
  await addNamed('New machine', original.name as string);
  await change('Layer', original.layer);
  for (const input of original.inputs ?? []) {
    await addNamed('Add input', input.name);
    await change(`${input.name} type`, input.type);
  }
  // The new machine's first state is renamed, the others added.
  const [first, ...others] = original.states;
  await change('State 1 name', first?.name as string);
  for (const each of others) await addNamed('Add state', each.name);
  for (const each of original.states) {
    if (typeof each.motion === 'string') await change(`${each.name} plays`, each.motion);
  }
  for (const [i, transition] of (original.transitions ?? []).entries()) {
    await press('Add transition');
    await change('From', transition.from);
    await change('To', transition.to);
    if (transition.duration != null) await change('Duration', String(transition.duration));
    if (transition.exitTime != null) await change('Exit time', String(transition.exitTime));
    for (const [c, condition] of (transition.conditions ?? []).entries()) {
      await press('Add condition');
      await change(`Condition ${c + 1} input`, condition.input);
      if (condition.value === false) {
        control(`Condition ${c + 1} value`).click();
        await settle();
      }
    }
    expect(state.value.document.machines?.at(-1)?.transitions?.[i], `transition ${i}`).toEqual(
      transition,
    );
  }
}

/** A document without its machines: what the test makes again. */
function without(document: MascotDocument): MascotDocument {
  const { machines: _, ...rest } = document;
  return rest;
}

describe('state machine editor', () => {
  it("makes Pip's emotion machine, and tries it with its inputs", async () => {
    const pip = readDocument(pipDocument());
    await mount(without(pip));
    await make(pip.machines?.[0] as MachineDocument);
    expect(state.value.document.machines).toEqual(pip.machines);
    expect(state.value.issues).toEqual([]);
    expect(problem.value).toBeNull();
    // Tried: it starts calm, turns happy on hover, and surprised on a poke.
    await press('Play');
    const active = () => document.querySelector('.machine-active')?.textContent;
    await expect.poll(active).toBe('emotion: calm');
    control('Input hover').click();
    await expect.poll(active, { timeout: 3000 }).toBe('emotion: happy');
    await press('Fire poke');
    await expect.poll(active, { timeout: 3000 }).toBe('emotion: surprised');
    // The graph lights the state the machine is in.
    expect(document.querySelector('.machine-state.active text')?.textContent).toBe('surprised');
    await press('Stop');
    expect(previewing.value).toBe(false);
  });

  for (const [title, read] of [
    ['Gloop', () => readDocument(gloopDocument)],
    ['Miso', () => readDocument(misoDocument)],
  ] as const) {
    it(`makes ${title}'s react machine, and hops it with a poke`, async () => {
      const original = read();
      await mount(without(original));
      await make(original.machines?.[0] as MachineDocument);
      expect(state.value.document.machines).toEqual(original.machines);
      expect(state.value.issues).toEqual([]);
      await press('Play');
      const active = () => document.querySelector('.machine-active')?.textContent;
      await expect.poll(active).toBe('react: rest');
      await press('Fire poke');
      await expect.poll(active, { timeout: 3000 }).toBe('react: hop');
      // The hop plays once, then the machine goes back to rest by its exit time.
      await expect.poll(active, { timeout: 5000 }).toBe('react: rest');
    });
  }

  it('renames a state everywhere, and removes one with its transitions', async () => {
    const gloop = readDocument(gloopDocument);
    await mount(gloop);
    await change('State 1 name', 'idle');
    const machine = () => state.value.document.machines?.[0] as MachineDocument;
    expect(machine().transitions?.map((each) => [each.from, each.to])).toEqual([
      ['idle', 'hop'],
      ['hop', 'idle'],
    ]);
    // A name another state has, or the any-state's, is refused.
    await change('State 1 name', 'hop');
    expect(problem.value).toMatch(/name of its own/);
    expect(control('State 1 name').value).toBe('idle');
    await press('Remove state hop');
    expect(machine().states).toEqual([{ name: 'idle' }]);
    expect(machine().transitions).toBeUndefined();
  });

  it('compares a number input, and shows malformed machines without breaking', async () => {
    const pip = readDocument(pipDocument());
    await mount(pip);
    await addNamed('Add input', 'mood');
    await change('mood type', 'number');
    await press('calm → happy');
    await press('Add condition');
    await change('Condition 2 input', 'mood');
    await change('Condition 2 op', '>=');
    await change('Condition 2 value', '0.5');
    expect(state.value.document.machines?.[0]?.transitions?.[1]?.conditions).toEqual([
      { input: 'hover' },
      { input: 'mood', op: '>=', value: 0.5 },
    ]);
    expect(state.value.issues).toEqual([]);
    openDocument({ ...pip, machines: 'oops' } as unknown as MascotDocument, null);
    await settle();
    expect(document.body.textContent).toMatch(/The machines are malformed/);
    await press('Remove the machines');
    expect(state.value.document.machines).toBeUndefined();
  });
});
