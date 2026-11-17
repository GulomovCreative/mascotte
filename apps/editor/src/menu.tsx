import { ARCHETYPES } from '@mascotte/library';
import { newDocument, REFERENCE_DOCUMENTS, readDocumentText } from './files/documents.ts';
import { openFile, saveFile } from './files/io.ts';
import {
  currentHandle,
  discardDraft,
  editor,
  fileName,
  markSaved,
  offeredDraft,
  openDocument,
  problem,
  savedDocument,
  state,
} from './store.ts';

/** Runs `task`, showing what goes wrong in the menu bar. */
async function attempt(task: () => Promise<void> | void): Promise<void> {
  try {
    await task();
  } catch (error) {
    problem.value = error instanceof Error ? error.message : String(error);
  }
}

async function save(as: boolean): Promise<void> {
  const document = state.value.document;
  const name = fileName.value ?? `${document.meta.name || 'mascot'}.json`;
  const saved = await saveFile(document, name, as ? null : currentHandle());
  if (saved) markSaved(saved.name, saved.handle);
}

/** A select that runs `choose` with the option picked, then shows its label again. */
function Choice(props: {
  label: string;
  options: readonly string[];
  choose: (value: string) => void;
}) {
  return (
    <select
      aria-label={props.label}
      value=""
      onChange={(event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        (event.currentTarget as HTMLSelectElement).value = '';
        if (value) props.choose(value);
      }}
    >
      <option value="">{props.label}</option>
      {props.options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

/**
 * The menu bar: new documents by archetype, open and save, the reference mascots, undo and redo,
 * the document's name (with a mark while unsaved), its issues and what went wrong last.
 */
export function MenuBar() {
  const current = state.value;
  const unsaved = current.document !== savedDocument.value;
  const issues = current.issues.length;
  return (
    <header class="menubar">
      <h1>Mascotte Editor</h1>
      <nav class="menu" aria-label="File">
        <Choice
          label="New"
          options={[...ARCHETYPES.keys()]}
          choose={(archetype) => attempt(() => openDocument(newDocument(archetype), null))}
        />
        <button
          type="button"
          onClick={() =>
            attempt(async () => {
              const opened = await openFile();
              if (opened) openDocument(opened.document, opened.name, opened.handle);
            })
          }
        >
          Open…
        </button>
        <Choice
          label="Reference"
          options={[...REFERENCE_DOCUMENTS.keys()]}
          choose={(name) =>
            attempt(() => openDocument((REFERENCE_DOCUMENTS.get(name) as () => never)(), null))
          }
        />
        <button type="button" onClick={() => attempt(() => save(false))}>
          Save
        </button>
        <button type="button" onClick={() => attempt(() => save(true))}>
          Save as…
        </button>
        <button type="button" disabled={!current.canUndo} onClick={() => editor.value.undo()}>
          Undo
        </button>
        <button type="button" disabled={!current.canRedo} onClick={() => editor.value.redo()}>
          Redo
        </button>
      </nav>
      <span class="document-title">
        {current.document.meta.name}
        {fileName.value ? ` — ${fileName.value}` : ''}
        {unsaved ? ' •' : ''}
      </span>
      {issues > 0 ? (
        <span class="issues" role="status">
          {issues === 1 ? '1 issue' : `${issues} issues`}
          {current.stale ? ' (showing the last valid scene)' : ''}
        </span>
      ) : null}
      {problem.value ? (
        <span class="problem" role="alert">
          {problem.value}
          <button type="button" aria-label="Dismiss" onClick={() => (problem.value = null)}>
            ×
          </button>
        </span>
      ) : null}
    </header>
  );
}

/** Offers back a draft kept by an earlier visit, until it is restored or discarded. */
export function DraftBanner() {
  const draft = offeredDraft.value;
  if (!draft) return null;
  const when = new Date(draft.savedAt).toLocaleString();
  return (
    <section class="draft" aria-label="Draft">
      <span>An unsaved draft from {when} was kept.</span>
      <button
        type="button"
        onClick={() => attempt(() => openDocument(readDocumentText(draft.text), draft.fileName))}
      >
        Restore
      </button>
      <button type="button" onClick={discardDraft}>
        Discard
      </button>
    </section>
  );
}
