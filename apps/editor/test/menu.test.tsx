import { render } from 'preact';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { offeredDraft, openDocument, state } from '../src/store.ts';

let host: HTMLDivElement | null = null;

beforeAll(async () => {
  // The editor is laid out for a desktop window; the test frame is a phone's by default.
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

function mount(): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  render(<App />, host);
  return host;
}

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
  openDocument(newDocument('blob'), null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function choose(root: HTMLElement, label: string, value: string): void {
  const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!select) throw new Error(`no ${label} menu`);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

const title = (root: HTMLElement) => root.querySelector('.document-title')?.textContent ?? '';

/**
 * The share of the viewport's pixels that are green, as the page shows it (a screenshot: WebGL
 * keeps no frame to read back once it is shown).
 */
async function greenShare(root: HTMLElement): Promise<number> {
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.viewport');
  if (!canvas) throw new Error('no viewport');
  const shot = await page.elementLocator(canvas).screenshot({ base64: true, save: false });
  const image = new Image();
  image.src = `data:image/png;base64,${typeof shot === 'string' ? shot : shot.base64}`;
  await image.decode();
  const copy = document.createElement('canvas');
  copy.width = image.width;
  copy.height = image.height;
  const ctx = copy.getContext('2d');
  if (!ctx) throw new Error('no 2D context');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  let green = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (g > r + 40 && g > b) green++;
  }
  return green / (data.length / 4);
}

describe('editor menu', () => {
  it('opens a reference mascot and draws it', { timeout: 30000 }, async () => {
    const root = mount();
    choose(root, 'Reference', 'Gloop');
    await expect.poll(() => title(root)).toBe('Gloop');
    expect(state.value.issues).toEqual([]);
    // Gloop's green body is drawn: a fair share of the frame, the rest its background.
    await expect.poll(() => greenShare(root), { timeout: 15000 }).toBeGreaterThan(0.02);
  });

  it('makes a new document of an archetype', async () => {
    const root = mount();
    choose(root, 'New', 'quadruped');
    await expect.poll(() => state.value.document.archetype).toBe('quadruped');
    expect(state.value.issues).toEqual([]);
    expect(title(root)).toBe('Untitled');
  });

  it('saves as a download where the browser has no file pickers, and marks the document saved', async () => {
    const root = mount();
    choose(root, 'Reference', 'Miso');
    await expect.poll(() => title(root)).toBe('Miso');
    // As in a browser without the File System Access API.
    vi.stubGlobal('showSaveFilePicker', undefined);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    const save = [...root.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save',
    );
    save?.click();
    await expect.poll(() => clicks).toEqual(['Miso.json']);
    await expect.poll(() => title(root)).toBe('Miso — Miso.json');
  });

  it('offers a kept draft back, and restores it', async () => {
    const draft = newDocument('bird');
    offeredDraft.value = {
      text: JSON.stringify({ ...draft, meta: { name: 'Draft' } }),
      savedAt: 0,
      fileName: 'bird.json',
    };
    const root = mount();
    const restore = [...root.querySelectorAll('button')].find(
      (button) => button.textContent === 'Restore',
    );
    if (!restore) throw new Error('no draft offered');
    restore.click();
    await expect.poll(() => title(root)).toBe('Draft — bird.json');
    expect(root.querySelector('[aria-label=Draft]')).toBeNull();
  });
});
