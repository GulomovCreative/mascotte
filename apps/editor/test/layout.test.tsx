import { render } from 'preact';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App, bottomTab } from '../src/app.tsx';

let host: HTMLDivElement | null = null;

// The editor's own stylesheet, as its page links it: the layout depends on it.
beforeAll(async () => {
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
  // Wide enough for the side panels and a viewport between them (the test frame is narrow).
  host.style.width = '1200px';
  document.body.append(host);
  render(<App />, host);
  return host;
}

function viewportCanvas(root: HTMLElement): HTMLCanvasElement {
  const canvas = root.querySelector<HTMLCanvasElement>('canvas.viewport');
  if (!canvas) throw new Error('no viewport canvas');
  return canvas;
}

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
  bottomTab.value = 'Timeline';
  vi.restoreAllMocks();
});

describe('editor layout', () => {
  it('has the tree, the viewport, the inspector and the animation tabs', () => {
    const root = mount();
    for (const label of ['Scene', 'Viewport', 'Inspector', 'Animation']) {
      expect(root.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    }
    const tabs = [...root.querySelectorAll('[role=tab]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['Timeline', 'State machines']);
  });

  it('switches the bottom tab', async () => {
    const root = mount();
    const machines = root.querySelectorAll<HTMLButtonElement>('[role=tab]')[1];
    if (!machines) throw new Error('no state machines tab');
    machines.click();
    await expect.poll(() => machines.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby')).toBe(
      machines.id,
    );
    // Only the open tab is a tab stop; the arrow keys move between tabs.
    expect(machines.tabIndex).toBe(0);
    machines.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const timeline = root.querySelectorAll<HTMLButtonElement>('[role=tab]')[0];
    await expect.poll(() => timeline?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(timeline);
    expect(machines.tabIndex).toBe(-1);
  });

  it('fits the viewport canvas to its panel, also when the panel resizes', async () => {
    const root = mount();
    const canvas = viewportCanvas(root);
    // The stage under the viewport's bar.
    const area = root.querySelector<HTMLElement>('.viewport-stage');
    if (!area) throw new Error('no viewport stage');
    const ratio = devicePixelRatio || 1;
    // The panel's size, not the canvas default of 300 × 150.
    await expect.poll(() => canvas.width).toBe(Math.round(area.clientWidth * ratio));
    expect(canvas.width).not.toBe(300);
    expect(canvas.height).toBe(Math.round(area.clientHeight * ratio));
    const before = canvas.width;
    root
      .querySelector<HTMLElement>('.editor')
      ?.style.setProperty('grid-template-columns', '240px 1fr 480px');
    await expect.poll(() => canvas.width).toBe(before - Math.round(200 * ratio));
  });

  it('draws with WebGL2 and lets its context go when it is unmounted', async () => {
    const root = mount();
    const canvas = viewportCanvas(root);
    // The renderer starts after the first paint, and fits the canvas.
    await expect.poll(() => canvas.width).not.toBe(300);
    const gl = canvas.getContext('webgl2');
    expect(gl).not.toBeNull();
    expect(gl?.isContextLost()).toBe(false);
    if (host) render(null, host);
    // The browser marks the context lost on its own time.
    await expect.poll(() => gl?.isContextLost()).toBe(true);
  });

  it('draws with Canvas 2D where the browser has no WebGL2', () => {
    const original = HTMLCanvasElement.prototype.getContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind === 'webgl2') return null;
      return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest) as never;
    } as never);
    const root = mount();
    expect(viewportCanvas(root).getContext('2d')).not.toBeNull();
  });
});
