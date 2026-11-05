import { Ticker } from '@mascotte/engine';
import { bindTickerToPage } from '@mascotte/player';
import { type Example, type ExampleControls, examples } from './examples.ts';

// One frame loop per page: it pauses while the tab is hidden. The playground is a debugging
// tool, so `prefers-reduced-motion` does not stop the animation here.
bindTickerToPage(Ticker.shared, { reducedMotion: 'ignore' });

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`No element #${id}`);
  return node as T;
}

const nav = element<HTMLElement>('examples');
const viewport = element<HTMLElement>('viewport');
const title = element<HTMLHeadingElement>('example-title');
const animateToggle = element<HTMLInputElement>('animate');
const fpsLabel = element<HTMLSpanElement>('fps');

/** Shows an error instead of the example and logs it to the console. */
function showError(error: unknown): void {
  console.error(error);
  fpsLabel.textContent = 'error';
  const message = document.createElement('pre');
  message.className = 'error';
  message.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
  viewport.replaceChildren(message);
}

let frames = 0;
let fpsStart = performance.now();
const controls: ExampleControls = {
  get animate() {
    return animateToggle.checked;
  },
  frame() {
    frames += 1;
    const now = performance.now();
    if (now - fpsStart >= 500) {
      fpsLabel.textContent = `${Math.round((frames * 1000) / (now - fpsStart))} fps`;
      frames = 0;
      fpsStart = now;
    }
  },
  error: showError,
};

const groups = new Map<string, Example[]>();
for (const example of examples) {
  groups.set(example.group, [...(groups.get(example.group) ?? []), example]);
}
for (const [group, items] of groups) {
  const heading = document.createElement('h3');
  heading.textContent = group;
  nav.append(heading);
  for (const example of items) {
    const link = document.createElement('a');
    link.href = `#${example.id}`;
    link.textContent = example.title;
    link.dataset.id = example.id;
    nav.append(link);
  }
}

let unmount: (() => void) | undefined;

function show(id: string): void {
  unmount?.();
  unmount = undefined;
  viewport.replaceChildren();
  fpsLabel.textContent = '';

  const example = examples.find((item) => item.id === id) ?? examples[0];
  if (!example) {
    title.textContent = 'No examples';
    return;
  }
  if (example.id !== id) {
    if (id) console.warn(`Example "${id}" not found, showing "${example.id}".`);
    history.replaceState(null, '', `#${example.id}`);
  }

  title.textContent = example.title;
  for (const link of nav.querySelectorAll('a')) {
    if (link.dataset.id === example.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  try {
    unmount = example.mount(viewport, controls);
  } catch (error) {
    showError(error);
  }
}

window.addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));
