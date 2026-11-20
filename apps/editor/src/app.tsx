import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { DraftBanner, MenuBar } from './menu.tsx';
import { DocumentPanel } from './panels/document-panel.tsx';
import { Inspector } from './panels/inspector.tsx';
import { SceneTree } from './panels/scene-tree.tsx';
import { state } from './store.ts';
import { Viewport } from './viewport/viewport.tsx';

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

/** The id of a bottom tab's button, which its panel is labelled by. */
const tabId = (tab: BottomTab) => `tab-${tab.toLowerCase().replace(/\s+/g, '-')}`;

/**
 * The bottom panel: the timeline and the state machine editor, in tabs. Only the open tab is a
 * tab stop; the arrow keys, Home and End move between tabs (the tabs pattern of ARIA).
 */
function BottomPanel() {
  const open = bottomTab.value;
  const select = (tab: BottomTab, focus: boolean) => {
    bottomTab.value = tab;
    if (focus) document.getElementById(tabId(tab))?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const at = BOTTOM_TABS.indexOf(open);
    const count = BOTTOM_TABS.length;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (at + 1) % count;
        break;
      case 'ArrowLeft':
        next = (at + count - 1) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(BOTTOM_TABS[next] as BottomTab, true);
  };
  return (
    <section class="panel bottom" aria-label="Animation">
      <div class="tabs" role="tablist" onKeyDown={onKeyDown}>
        {BOTTOM_TABS.map((tab) => (
          <button
            key={tab}
            id={tabId(tab)}
            type="button"
            role="tab"
            aria-selected={tab === open}
            aria-controls="bottom-panel"
            tabIndex={tab === open ? 0 : -1}
            onClick={() => select(tab, false)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div class="panel-body" id="bottom-panel" role="tabpanel" aria-labelledby={tabId(open)}>
        <p class="empty">{open === 'Timeline' ? 'No motion open.' : 'No machine open.'}</p>
      </div>
    </section>
  );
}

/**
 * The editor: a menu bar, the viewport in the middle, the scene tree on the left, the inspector
 * on the right, the timeline and the state machine editor in tabs at the bottom (docs/EDITOR.md,
 * 3.9; the preview comes with #97).
 */
export function App() {
  return (
    <div class="editor">
      <MenuBar />
      <DraftBanner />
      <Panel title="Scene" area="tree">
        <SceneTree />
      </Panel>
      <main class="viewport-area" aria-label="Viewport">
        <Viewport />
      </main>
      <Panel title="Inspector" area="inspector">
        {/* With nothing selected, the inspector shows the document. */}
        {state.value.selection === null ? (
          <DocumentPanel />
        ) : (
          <Inspector path={state.value.selection} />
        )}
      </Panel>
      <BottomPanel />
    </div>
  );
}
