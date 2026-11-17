import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { Viewport } from './viewport.tsx';

/** The tabs of the bottom panel. */
export const BOTTOM_TABS = ['Timeline', 'State machines'] as const;
export type BottomTab = (typeof BOTTOM_TABS)[number];

/** The open tab of the bottom panel. */
export const bottomTab = signal<BottomTab>('Timeline');

/** A titled panel of the layout. */
function Panel(props: { title: string; area: string; children?: ComponentChildren }) {
  return (
    <section class={`panel ${props.area}`} aria-label={props.title}>
      <h2 class="panel-title">{props.title}</h2>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}

/** The bottom panel: the timeline and the state machine editor, in tabs. */
function BottomPanel() {
  const open = bottomTab.value;
  return (
    <section class="panel bottom" aria-label="Animation">
      <div class="tabs" role="tablist">
        {BOTTOM_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={tab === open}
            onClick={() => {
              bottomTab.value = tab;
            }}
          >
            {tab}
          </button>
        ))}
      </div>
      <div class="panel-body" role="tabpanel" aria-label={open}>
        <p class="empty">{open === 'Timeline' ? 'No motion open.' : 'No machine open.'}</p>
      </div>
    </section>
  );
}

/**
 * The editor: the viewport in the middle, the scene tree on the left, the inspector on the
 * right, the timeline and the state machine editor in tabs at the bottom (docs/EDITOR.md, 3.9).
 */
export function App() {
  return (
    <div class="editor">
      <header class="menubar">
        <h1>Mascotte Editor</h1>
      </header>
      <Panel title="Scene" area="tree">
        <p class="empty">No document open.</p>
      </Panel>
      <main class="viewport-area" aria-label="Viewport">
        <Viewport />
      </main>
      <Panel title="Inspector" area="inspector">
        <p class="empty">Nothing selected.</p>
      </Panel>
      <BottomPanel />
    </div>
  );
}
