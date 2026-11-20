import type { MascotDocument, NodeDocument } from '@mascotte/format';
import { readDocument } from '@mascotte/format';
import { misoDocument } from '@mascotte/reference';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { nodeAt } from '../src/model/paths.ts';
import {
  editor,
  editPrefab,
  leavePrefab,
  offeredDraft,
  openDocument,
  prefabMode,
  problem,
  state,
} from '../src/store.ts';

let host: HTMLDivElement | null = null;

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
  if (prefabMode.value) leavePrefab(false);
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

/** The control labelled `label` (by `aria-label`, or a label's text) inside `within`. */
function control<T extends HTMLElement = HTMLInputElement>(label: string, within = 'body'): T {
  const scope = document.querySelector(within);
  const found =
    scope?.querySelector<T>(`[aria-label="${label}"]`) ??
    ([...(scope?.querySelectorAll('label') ?? [])]
      .find((each) => each.firstChild?.textContent?.trim() === label)
      ?.querySelector<T>('input, select, textarea') as T | undefined);
  if (!found) throw new Error(`no control ${label} in ${within}`);
  return found;
}

async function change(label: string, value: string, within?: string): Promise<void> {
  const field = control<HTMLInputElement | HTMLSelectElement>(label, within);
  field.value = value;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

/** Types a name into the add row `label` and presses its button. */
async function addNamed(label: string, name: string): Promise<void> {
  const input = control(`${label} name`);
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const button = [...document.querySelectorAll('button')].find(
    (each) => each.textContent === label,
  );
  if (!button) throw new Error(`no button ${label}`);
  button.click();
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

async function select(path: readonly number[] | null): Promise<void> {
  editor.value.select(path);
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

describe('palettes, parameters, prefabs and rig', () => {
  it("makes Miso's palettes, its catEar prefab with its length parameter, and its slots", async () => {
    const miso = readDocument(misoDocument);
    await mount(newDocument('quadruped'));
    await select(null);

    // Palettes: the base gets every role, then each palette its colors.
    const palettes = miso.palettes ?? {};
    const [base] = Object.keys(palettes);
    for (const name of Object.keys(palettes)) await addNamed('Add palette', name);
    for (const role of Object.keys(palettes[base as string] ?? {}))
      await addNamed('Add role', role);
    for (const [name, colors] of Object.entries(palettes)) {
      for (const [role, color] of Object.entries(colors)) {
        await change(role, color, `[aria-label="Palette ${name}"]`);
      }
    }
    expect(state.value.document.palettes).toEqual(miso.palettes);

    // The ear length, and a preview of it that leaves the document alone.
    await addNamed('Add parameter', 'earLength');
    await change('earLength default', '14');
    await change('earLength min', '8');
    await change('earLength max', '22');
    await change('Description', 'How tall the ears stand.', '[aria-label="Parameter earLength"]');
    expect(state.value.document.params).toEqual(miso.params);

    // An ear on the head, made a prefab.
    const head = pathOf('head');
    await select(head);
    const menu = control<HTMLSelectElement>('Add');
    menu.value = 'type:PathShape';
    menu.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await change('style.stroke', '4');
    const name = control('Prefab name');
    name.value = 'catEar';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    await press('Make prefab');
    const ear = state.value.selection as number[];
    expect(nodeAt(state.value.document, ear)).toEqual({ prefab: 'catEar', id: 'pathshape' });

    // In its own mode: its length parameter, and a point that it moves.
    await select(null);
    await press('Edit prefab catEar');
    expect(prefabMode.value?.name).toBe('catEar');
    await addNamed('Add parameter', 'length');
    await change('length default', '14');
    await change('length min', '4');
    await select([]);
    for (let i = 0; i < 3; i++) await press('Add point');
    await change('Path 2 point x', '7');
    await change('Path 3 point source', 'param');
    await change('Path 3 point times x', '0');
    await change('Path 3 point times y', '-1');
    await change('Path 3 point times z', '0');
    expect(state.value.issues).toEqual([]);
    await press('Done');
    expect(prefabMode.value).toBeNull();
    const catEar = state.value.document.prefabs?.catEar;
    expect(catEar?.params).toEqual(miso.prefabs?.catEar?.params);
    expect(catEar?.root.path?.[2]).toEqual(miso.prefabs?.catEar?.root.path?.[2]);
    // The whole mode is one step.
    expect(state.value.undoLabel).toBe('Set prefabs.catEar');

    // Two ears, their length bound to the document's, in the rig's ear slots.
    await select(ear);
    await change('param length source', 'param');
    expect(nodeAt(state.value.document, ear)?.params).toEqual({ length: { param: 'earLength' } });
    await select(null);
    await change('Slot ear.L', 'pathshape');
    expect(state.value.document.rig?.slots?.['ear.L']).toBe('pathshape');
    expect(state.value.issues).toEqual([]);
    expect(problem.value).toBeNull();
  });

  it('previews a palette and a parameter value without changing the document', async () => {
    await mount(readDocument(misoDocument));
    const document = state.value.document;
    const color = () => {
      const skull = state.value.scene?.built.root.findById('skull');
      return (skull as unknown as { style: { color: string } } | null)?.style.color;
    };
    const ginger = color();
    await change('Palette', 'smoke');
    expect(state.value.preview).toEqual({ palette: 'smoke' });
    expect(color()).not.toBe(ginger);
    await select(null);
    const slider = control('earLength preview');
    slider.value = '20';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(state.value.preview).toEqual({ palette: 'smoke', params: { earLength: 20 } });
    expect(state.value.document).toBe(document);
    expect(state.value.canUndo).toBe(false);
    await press('Reset earLength preview');
    expect(state.value.preview).toEqual({ palette: 'smoke' });
    // A preview stays through changes, as far as the document has its names.
    await press('Remove palette smoke');
    expect(state.value.preview).toEqual({});
    expect(color()).toBe(ginger);
    editor.value.undo();
    expect(state.value.preview).toEqual({ palette: 'smoke' });
  });

  it("edits a library prefab as the document's own, and drops a cancelled mode", async () => {
    await mount(newDocument('blob'));
    editPrefab('eye');
    await settle();
    expect(state.value.document.meta.name).toBe('eye');
    const save = [...document.querySelectorAll('button')].find(
      (each) => each.textContent === 'Save',
    );
    expect(save?.disabled).toBe(true);
    // Nothing changed: no prefab of its own.
    leavePrefab(true);
    expect(state.value.document.prefabs).toBeUndefined();
    editPrefab('eye');
    await select([]);
    await change('position x', '3');
    leavePrefab(false);
    expect(state.value.document.prefabs).toBeUndefined();
    editPrefab('eye');
    await select([]);
    await change('position x', '3');
    await select(null);
    await press('Done');
    expect(state.value.document.prefabs?.eye?.root.props?.position).toEqual({ x: 3, y: 0, z: 0 });
    expect(state.value.document.prefabs?.eye?.params).toBeDefined();
    // Opening another document ends a mode.
    editPrefab('mouth');
    openDocument(newDocument('blob'), null);
    expect(prefabMode.value).toBeNull();
    expect(state.value.document.prefabs).toBeUndefined();
  });

  it('offers no prefab inside a prefab, and refuses names taken', async () => {
    await mount(newDocument('blob'));
    await select(null);
    await addNamed('Add prefab', 'eye');
    expect(problem.value).toMatch(/prefab "eye" already/);
    await addNamed('Add prefab', 'drop');
    expect(state.value.document.prefabs?.drop).toEqual({ root: { type: 'Node' } });
    await press('Edit prefab drop');
    const groups = [...control<HTMLSelectElement>('Add').querySelectorAll('optgroup')];
    expect(groups.map((group) => group.label)).toEqual(['Shapes']);
    await select([]);
    expect(document.querySelector('[aria-label="Prefab name"]')).toBeNull();
  });

  it("shows an instance's root values as its parameters make them", async () => {
    await mount({
      ...newDocument('blob'),
      root: {
        ...newDocument('blob').root,
        children: [{ prefab: 'mouth', id: 'it', params: { stroke: 5 } }],
      },
    });
    await select([0]);
    // The mouth's stroke is its `stroke` parameter: 5 here, 3 by default.
    expect(control('style.stroke').placeholder).toBe('5');
    await change('param stroke', '');
    expect(control('style.stroke').placeholder).toBe('3');
    expect(control('param stroke').placeholder).toBe('3');
  });
});
