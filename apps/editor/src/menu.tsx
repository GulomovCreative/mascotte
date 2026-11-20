import { ARCHETYPES } from '@mascotte/library';
import { newDocument, REFERENCE_DOCUMENTS, readDocumentText } from './files/documents.ts';
import { openFile, saveFile } from './files/io.ts';
import {
  attempt,
  currentHandle,
  discardDraft,
  editor,
  fileName,
  isUnsaved,
  leavePrefab,
  markSaved,
  offeredDraft,
  openDocument,
  prefabMode,
  problem,
  state,
} from './store.ts';

/**
 * Whether the open document may be replaced: asked when it has unsaved changes, or when a draft
 * is on offer (replacing the document sets the draft aside for good).
 */
function mayReplace(): boolean {
  if (offeredDraft.value !== null) {
    return confirm(
      isUnsaved()
        ? 'Replace the document? Its unsaved changes and the draft offered will be lost.'
        : 'Replace the document? The unsaved draft offered will be discarded.',
    );
  }
  return !isUnsaved() || confirm('Replace the document? Its unsaved changes will be lost.');
}

async function save(as: boolean): Promise<void> {
  const from = editor.value;
  const document = from.state.document;
  const named = document.meta?.name;
  const name = fileName.value ?? `${typeof named === 'string' && named ? named : 'mascot'}.json`;
  const saved = await saveFile(document, name, as ? null : currentHandle());
  if (saved) markSaved(saved, document, from);
}

/** A select that runs `choose` with the option picked, then shows its label again. */
function Choice(props: {
  label: string;
  options: readonly string[];
  disabled?: boolean;
  choose: (value: string) => void;
}) {
  return (
    <select
      aria-label={props.label}
      disabled={props.disabled}
      value=""
      onChange={(event) => {
        const select = event.currentTarget as HTMLSelectElement;
        const value = select.value;
        select.value = '';
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
  // While a prefab is edited, the file waits: its edits reach the document when its mode ends.
  const busy = prefabMode.value !== null;
  const unsaved = isUnsaved();
  const issues = current.issues.length;
  return (
    <header class="menubar">
      <h1>Mascotte Editor</h1>
      <nav class="menu" aria-label="File">
        <Choice
          label="New"
          options={[...ARCHETYPES.keys()]}
          disabled={busy}
          choose={(archetype) =>
            mayReplace() &&
            attempt('Could not make it', () => openDocument(newDocument(archetype), null))
          }
        />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            mayReplace() &&
            attempt('Could not open the file', async () => {
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
          disabled={busy}
          choose={(name) => {
            const make = REFERENCE_DOCUMENTS.get(name);
            if (make && mayReplace()) {
              attempt(`Could not open ${name}`, () => openDocument(make(), null));
            }
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => attempt('Could not save', () => save(false))}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => attempt('Could not save', () => save(true))}
        >
          Save as…
        </button>
        <button
          type="button"
          disabled={!current.canUndo}
          onClick={() => attempt('Could not undo', () => editor.value.undo())}
        >
          Undo
        </button>
        <button
          type="button"
          disabled={!current.canRedo}
          onClick={() => attempt('Could not redo', () => editor.value.redo())}
        >
          Redo
        </button>
      </nav>
      <span class="document-title">
        {busy ? prefabMode.value?.outer.state.document.meta?.name : current.document.meta?.name}
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
  // Its place shows the prefab's mode meanwhile; it is offered again when the mode ends.
  if (!draft || prefabMode.value) return null;
  const when = new Date(draft.savedAt).toLocaleString();
  return (
    <section class="draft" aria-label="Draft">
      <span>An unsaved draft from {when} was kept.</span>
      <button
        type="button"
        onClick={() =>
          (!isUnsaved() ||
            confirm('Restore the draft? The unsaved changes made since will be lost.')) &&
          attempt('Could not restore the draft', () =>
            openDocument(readDocumentText(draft.text), draft.fileName, null, true),
          )
        }
      >
        Restore
      </button>
      <button type="button" onClick={discardDraft}>
        Discard
      </button>
    </section>
  );
}

/** While a prefab is edited in its own mode: its name, and the way back to the document. */
export function PrefabBanner() {
  const mode = prefabMode.value;
  if (!mode) return null;
  return (
    <section class="draft prefab-mode" aria-label="Prefab">
      <span>
        Editing the prefab <strong>{mode.name}</strong>: its tree and parameters. Its colors take
        the document's palette roles.
      </span>
      <button
        type="button"
        onClick={() => attempt('Could not apply the prefab', () => leavePrefab(true))}
      >
        Done
      </button>
      <button
        type="button"
        onClick={() =>
          (!state.value.canUndo || confirm("Drop the prefab's changes?")) && leavePrefab(false)
        }
      >
        Cancel
      </button>
    </section>
  );
}
