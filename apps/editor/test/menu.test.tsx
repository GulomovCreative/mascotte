import { render } from 'preact';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { keptDraft } from '../src/files/drafts.ts';
import { setProp } from '../src/model/commands.ts';
import { editor, offeredDraft, openDocument, state } from '../src/store.ts';

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
  offeredDraft.value = null;
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

const button = (root: HTMLElement, text: string) => {
  const found = [...root.querySelectorAll('button')].find((each) => each.textContent === text);
  if (!found) throw new Error(`no ${text} button`);
  return found;
};

/** A file handle in memory, as the File System Access API gives, recording what is written. */
function memoryHandle(name: string, text = '') {
  const written: string[] = [];
  const handle = {
    name,
    getFile: async () => new File([text], name),
    createWritable: async () => {
      let data = '';
      return {
        write: async (chunk: string) => {
          data += chunk;
        },
        close: async () => {
          written.push(data);
        },
      };
    },
  };
  return { handle, written };
}

/** Makes an edit, as the inspector will. */
const edit = () => editor.value.execute(setProp([0], 'visible', false));

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

  it('saves as a download where the browser has no file pickers, and keeps the draft', async () => {
    const root = mount();
    choose(root, 'Reference', 'Miso');
    await expect.poll(() => title(root)).toBe('Miso');
    edit();
    // As in a browser without the File System Access API.
    vi.stubGlobal('showSaveFilePicker', undefined);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    button(root, 'Save').click();
    await expect.poll(() => clicks).toEqual(['Miso.json']);
    await expect.poll(() => title(root)).toBe('Miso — Miso.json');
    // The download may yet be cancelled: the draft of the edit stays.
    await expect.poll(() => keptDraft()?.text).toBe(JSON.stringify(state.value.document));
  });

  it('opens with the file picker, saves in place, and marks changes unsaved till then', async () => {
    const root = mount();
    const file = memoryHandle('gloop.json', JSON.stringify(newDocument('bird')));
    const pick = vi.fn(async () => [file.handle]);
    vi.stubGlobal('showOpenFilePicker', pick);
    const save = vi.fn();
    vi.stubGlobal('showSaveFilePicker', save);
    button(root, 'Open…').click();
    await expect.poll(() => title(root)).toBe('Untitled — gloop.json');
    edit();
    await expect.poll(() => title(root)).toBe('Untitled — gloop.json •');
    button(root, 'Save').click();
    await expect.poll(() => file.written.length).toBe(1);
    expect(JSON.parse(file.written[0] ?? '')).toEqual(state.value.document);
    expect(save).not.toHaveBeenCalled();
    await expect.poll(() => title(root)).toBe('Untitled — gloop.json');
    expect(keptDraft()).toBeNull();
  });

  it('does nothing when a picker is cancelled, and says what failed otherwise', async () => {
    const root = mount();
    vi.stubGlobal('showOpenFilePicker', async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    button(root, 'Open…').click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(root.querySelector('[role=alert]')).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('showOpenFilePicker', async () => [memoryHandle('bad.json', '{').handle]);
    button(root, 'Open…').click();
    await expect
      .poll(() => root.querySelector('[role=alert]')?.textContent ?? '')
      .toMatch(/^Could not open the file: [\s\S]*not JSON/);
    expect(title(root)).toBe('Untitled');
  });

  it('asks before an unsaved document is replaced', async () => {
    const root = mount();
    edit();
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    choose(root, 'Reference', 'Pip');
    expect(ask).toHaveBeenCalledOnce();
    await expect.poll(() => title(root)).toBe('Untitled •');
    ask.mockReturnValue(true);
    choose(root, 'Reference', 'Pip');
    await expect.poll(() => title(root)).toBe('Pip');
  });

  it('offers a kept draft back, restores it unsaved, and keeps it', async () => {
    const draft = { ...newDocument('bird'), meta: { name: 'Draft' } };
    offeredDraft.value = { text: JSON.stringify(draft), savedAt: 0, fileName: 'bird.json' };
    localStorage.setItem(
      'mascotte-editor-draft',
      JSON.stringify({ text: JSON.stringify(draft), savedAt: 0, fileName: 'bird.json' }),
    );
    const root = mount();
    // While it is on offer, changes keep no draft over it.
    edit();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(keptDraft()?.text).toBe(JSON.stringify(draft));
    vi.stubGlobal('confirm', () => true);
    button(root, 'Restore').click();
    await expect.poll(() => title(root)).toBe('Draft — bird.json •');
    expect(root.querySelector('[aria-label=Draft]')).toBeNull();
    expect(keptDraft()?.text).toBe(JSON.stringify(draft));
  });
});
