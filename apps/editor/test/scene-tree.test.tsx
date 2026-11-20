import { type MascotDocument, type NodeDocument, readDocument } from '@mascotte/format';
import { gloopDocument } from '@mascotte/reference';
import { render } from 'preact';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { setProp } from '../src/model/commands.ts';
import { toggled } from '../src/panels/scene-tree.tsx';
import { editor, offeredDraft, openDocument, problem, state } from '../src/store.ts';

let host: HTMLDivElement | null = null;

beforeAll(async () => {
  await page.viewport(1280, 800);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/apps/editor/src/style.css';
  const loaded = new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = reject;
  });
  document.head.append(link);
  await loaded;
});

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
  toggled.value = new Set();
  offeredDraft.value = null;
  openDocument(newDocument('blob'), null);
});

function mount(): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  render(<App />, host);
  return host;
}

/** Lets Preact render what the last change did. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The tree row of the document's node `id` (not a made one). */
function row(id: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (each) =>
      each.getAttribute('aria-disabled') !== 'true' &&
      each.querySelector('.tree-id')?.textContent === id,
  );
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

/** Clicks the node `id`, which focuses it as a real click does. */
async function select(id: string): Promise<void> {
  row(id).focus();
  row(id).click();
  await settle();
}

async function key(id: string, name: string, options: KeyboardEventInit = {}): Promise<void> {
  row(id).dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...options }));
  await settle();
}

/** Adds a shape (`type:Sphere`) or a prefab instance (`prefab:mouth`) under the selection. */
async function add(value: string): Promise<void> {
  const menu = document.querySelector<HTMLSelectElement>('select[aria-label="Add"]');
  if (!menu) throw new Error('no Add menu');
  menu.value = value;
  menu.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

/** Renames the node `id` in place: F2, the new id, Enter. */
async function rename(id: string, to: string): Promise<void> {
  await key(id, 'F2');
  const input = document.querySelector<HTMLInputElement>('.tree-rename');
  if (!input) throw new Error('no rename input');
  input.value = to;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
}

/** Drags the node `from` onto `to`: its top edge, middle or bottom edge. */
async function drag(from: string, to: string, zone: 'before' | 'inside' | 'after'): Promise<void> {
  const source = row(from);
  const target = row(to);
  const transfer = new DataTransfer();
  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
  const box = target.getBoundingClientRect();
  const y = box.top + box.height * { before: 0.1, inside: 0.5, after: 0.9 }[zone];
  const at = { bubbles: true, cancelable: true, clientY: y, dataTransfer: transfer };
  target.dispatchEvent(new DragEvent('dragover', at));
  target.dispatchEvent(new DragEvent('drop', at));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  await settle();
}

/** A tree's outline: types or prefabs, and the ids where `like` (Gloop's) has them. */
function outline(node: NodeDocument, like: NodeDocument): unknown {
  return {
    kind: node.prefab ?? node.type,
    ...(like.id === undefined ? {} : { id: node.id }),
    children: (node.children ?? []).map((child, i) => outline(child, like.children?.[i] ?? child)),
  };
}

async function setField(label: string, value: string): Promise<void> {
  const field = [...document.querySelectorAll('.document-panel label')]
    .find((each) => each.firstChild?.textContent === label)
    ?.querySelector<HTMLInputElement>('input, textarea, select');
  if (!field) throw new Error(`no field ${label}`);
  field.value = value;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

describe('scene tree and document panel', () => {
  it("builds Gloop's tree from a new document", async () => {
    mount();
    await settle();
    await select('root');
    await rename('root', 'stage');
    await add('type:BlobShadow');
    await rename('blobshadow', 'shadow');
    await drag('shadow', 'body', 'before');
    await select('stage');
    await add('type:Node');
    await rename('node', 'gloop');
    await select('body');
    await rename('body', 'blob');
    await select('gloop');
    await add('type:Node');
    await rename('node', 'body');
    await drag('blob', 'body', 'inside');
    await drag('eyes', 'body', 'inside');
    await drag('lids', 'body', 'inside');
    await select('body');
    await add('prefab:mouth');
    // A node added by mistake, removed with the key.
    await select('body');
    await add('type:Cone');
    await key('cone', 'Delete');
    for (const name of ['drop', 'shine']) {
      await select('body');
      await add('type:Sphere');
      await rename('sphere', name);
      await drag(name, 'eyes', 'before');
    }
    await select('body');
    await add('type:Node');
    await rename('node', 'cheeks');
    await drag('cheeks', 'eyes', 'before');
    await add('type:Sphere');
    await key('sphere', 'd', { ctrlKey: true });
    // Nothing selected: the inspector shows the document.
    await key('sphere-2', 'Escape');
    await setField('Name', 'Gloop');
    await setField('Description', 'A round slime.');
    await setField('Background', '#fff4e6');

    expect(problem.value).toBeNull();
    const gloop = readDocument(gloopDocument) as MascotDocument;
    const built = state.value.document;
    expect(outline(built.root, gloop.root)).toEqual(outline(gloop.root, gloop.root));
    expect(built.view).toEqual(gloop.view);
    expect(built.camera).toEqual(gloop.camera);
    expect(built.archetype).toBe('blob');
    expect(built.meta).toEqual({ name: 'Gloop', description: 'A round slime.' });
    // The renames followed the rig.
    expect(built.rig?.slots).toMatchObject({ root: 'stage', body: 'blob' });
    expect(state.value.issues).toEqual([]);
  });

  it('shows made nodes read-only, marks slots and issues, and moves with the keys', async () => {
    mount();
    await settle();
    // An instance's made nodes are folded under it; unfolded, they are read-only.
    expect(() => row('eye-left')).not.toThrow();
    expect(document.querySelector('[aria-disabled="true"]')).toBeNull();
    const fold = row('eye-left').querySelector<HTMLButtonElement>('.tree-fold');
    fold?.click();
    await settle();
    const made = [...document.querySelectorAll<HTMLElement>('[aria-disabled="true"]')];
    expect(made.map((each) => each.querySelector('.tree-id')?.textContent)).toContain(
      'eye-left-pupil',
    );
    made[0]?.click();
    await settle();
    expect(state.value.selection).toEqual([0, 0, 0]);

    expect(row('body').querySelector('.slot')?.textContent).toBe('body');
    editor.value.execute(setProp([0], 'diameter', -1));
    await settle();
    expect(row('body').querySelector('.tree-issue')).not.toBeNull();

    await select('root');
    await key('root', 'ArrowDown');
    expect(state.value.selection).toEqual([0]);
    expect(document.activeElement).toBe(row('body'));
    await key('body', 'ArrowLeft');
    expect(state.value.selection).toEqual([0]);
    expect(row('body').getAttribute('aria-expanded')).toBe('false');
    await key('body', 'ArrowLeft');
    expect(state.value.selection).toEqual([]);
    // A node cannot be dropped into itself.
    await drag('root', 'body', 'inside');
    expect(state.value.document.root.id).toBe('root');
  });
});
