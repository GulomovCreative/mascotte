import { render } from 'preact';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { pathString } from '../src/model/paths.ts';
import { openDocument, state } from '../src/store.ts';
import { debugView, orbit, viewCamera } from '../src/viewport/viewport.tsx';

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
  viewCamera.value = 'orbit';
  debugView.value = { axes: true, bones: false, sort: false, anchors: false, frame: true };
  openDocument(newDocument('blob'), null);
});

async function mountPip(): Promise<HTMLCanvasElement> {
  host = document.createElement('div');
  document.body.append(host);
  render(<App />, host);
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Reference"]');
  if (!select) throw new Error('no menu');
  select.value = 'Pip';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await expect.poll(() => state.value.document.meta.name).toBe('Pip');
  const canvas = host.querySelector<HTMLCanvasElement>('canvas.viewport');
  if (!canvas) throw new Error('no viewport');
  // The viewport starts after the first paint: fitted, it listens.
  await expect.poll(() => canvas.width).not.toBe(300);
  return canvas;
}

function pointer(canvas: HTMLCanvasElement, type: string, x: number, y: number, buttons = 1) {
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      button: 0,
      buttons,
      clientX: rect.left + x,
      clientY: rect.top + y,
    }),
  );
}

/** How many pixels of the overlay are drawn on. */
function overlayInk(): number {
  const overlay = host?.querySelector<HTMLCanvasElement>('canvas.viewport-overlay');
  const ctx = overlay?.getContext('2d');
  if (!overlay || !ctx) throw new Error('no overlay');
  const { data } = ctx.getImageData(0, 0, overlay.width, overlay.height);
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) ink++;
  return ink;
}

describe('viewport', () => {
  it("picks Pip's nodes, shows the selection's axes, the bones and the sort order", async () => {
    const canvas = await mountPip();
    const { width, height } = canvas.getBoundingClientRect();
    // A click in the middle of the frame: Pip's body or something on it.
    pointer(canvas, 'pointerdown', width / 2, height / 2);
    pointer(canvas, 'pointerup', width / 2, height / 2, 0);
    await expect.poll(() => state.value.selection).not.toBeNull();
    expect(pathString(state.value.selection ?? [])).toMatch(/^root/);
    const axes = overlayInk();
    expect(axes).toBeGreaterThan(0);
    debugView.value = { ...debugView.value, bones: true, sort: true, anchors: true };
    await expect.poll(overlayInk).toBeGreaterThan(axes);
    // A click on the empty corner selects nothing.
    pointer(canvas, 'pointerdown', 3, 3);
    pointer(canvas, 'pointerup', 3, 3, 0);
    await expect.poll(() => state.value.selection).toBeNull();
  });

  it('turns the orbit by a drag and zooms by the wheel; looks through the document camera too', async () => {
    const canvas = await mountPip();
    pointer(canvas, 'pointerdown', 300, 300);
    pointer(canvas, 'pointermove', 360, 300);
    pointer(canvas, 'pointerup', 360, 300, 0);
    await expect.poll(() => orbit.value?.yaw ?? 0).toBeLessThan(0);
    // A drag selects nothing.
    expect(state.value.selection).toBeNull();
    const before = orbit.value?.zoom ?? 0;
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }),
    );
    expect(orbit.value?.zoom ?? 0).toBeGreaterThan(before);
    viewCamera.value = 'document';
    // The document's frame is drawn as a dashed rectangle.
    await expect.poll(overlayInk).toBeGreaterThan(0);
  });
});
