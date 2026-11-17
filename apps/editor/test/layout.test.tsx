import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App, bottomTab } from '../src/app.tsx';

/* The editor's layout in a real browser. */

let host: HTMLDivElement | null = null;

function mount(): HTMLDivElement {
  host = document.createElement('div');
  host.style.width = '1200px';
  host.style.height = '800px';
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
  bottomTab.value = 'Timeline';
});

describe('editor layout', () => {
  it('has the tree, the viewport, the inspector and the animation tabs', () => {
    const root = mount();
    const labels = [...root.querySelectorAll('[aria-label]')].map((node) =>
      node.getAttribute('aria-label'),
    );
    expect(labels).toEqual(expect.arrayContaining(['Scene', 'Viewport', 'Inspector', 'Animation']));
    const tabs = [...root.querySelectorAll('[role=tab]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['Timeline', 'State machines']);
  });

  it('switches the bottom tab', async () => {
    const root = mount();
    const machines = [...root.querySelectorAll<HTMLButtonElement>('[role=tab]')][1];
    machines?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(machines?.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('[role=tabpanel]')?.getAttribute('aria-label')).toBe(
      'State machines',
    );
  });

  it('fits the viewport canvas to its panel and draws on it', async () => {
    const root = mount();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const canvas = root.querySelector<HTMLCanvasElement>('canvas.viewport');
    if (!canvas) throw new Error('no viewport canvas');
    const ratio = devicePixelRatio || 1;
    expect(canvas.clientWidth).toBeGreaterThan(0);
    expect(canvas.width).toBe(Math.round(canvas.clientWidth * ratio));
    expect(canvas.height).toBe(Math.round(canvas.clientHeight * ratio));
  });
});
