import type { MascotDocument } from '@mascotte/format';
import { signal } from '@preact/signals';
import { newDocument } from './files/documents.ts';
import { type Draft, dropDraft, keepDraft, keptDraft } from './files/drafts.ts';
import type { FileHandle, SavedFile } from './files/io.ts';
import { EditorDocument, type EditorState } from './model/editor-document.ts';

/** The document being edited. */
export const editor = signal(new EditorDocument(newDocument('blob')));
/** Its state, a new value after every change. */
export const state = signal<EditorState>(editor.value.state);
/** The file it came from or was saved to: its name, or `null` for a new document. */
export const fileName = signal<string | null>(null);
/**
 * The document as last opened or saved, or `null` for one never saved (a restored draft): the
 * open document is unsaved while it differs.
 */
export const savedDocument = signal<MascotDocument | null>(editor.value.state.document);
/** What went wrong last (opening, saving), shown until dismissed. */
export const problem = signal<string | null>(null);
/**
 * A draft an earlier visit kept, offered back until it is restored or discarded; while it is on
 * offer no new draft is kept, so a change made meanwhile does not overwrite it.
 */
export const offeredDraft = signal<Draft | null>(keptDraft());

/** Whether the open document has changes no file holds. */
export const isUnsaved = () => state.value.document !== savedDocument.value;

let handle: FileHandle | null = null;
let unsubscribe = editor.value.subscribe(onChange);

// Drafts are kept a moment after the last change, not on every step of a drag.
const DRAFT_DELAY = 500;
let pendingDraft: ReturnType<typeof setTimeout> | undefined;

function keepDraftNow(): void {
  pendingDraft = undefined;
  keepDraft(editor.peek().state.document, fileName.peek());
}

function cancelDraft(): void {
  clearTimeout(pendingDraft);
  pendingDraft = undefined;
}

// A page closed before the delay is over still keeps its draft.
globalThis.addEventListener?.('pagehide', () => {
  if (pendingDraft !== undefined) {
    cancelDraft();
    keepDraftNow();
  }
});

function onChange(): void {
  state.value = editor.peek().state;
  if (offeredDraft.peek() !== null) return;
  cancelDraft();
  pendingDraft = setTimeout(keepDraftNow, DRAFT_DELAY);
}

/**
 * Starts editing `document`, from the file `name` (and `fileHandle`, to save in place). A
 * restored draft is `unsaved`: it stays kept, and is marked unsaved.
 */
export function openDocument(
  document: MascotDocument,
  name: string | null,
  fileHandle: FileHandle | null = null,
  unsaved = false,
): void {
  const previous = editor.peek();
  unsubscribe();
  cancelDraft();
  const next = new EditorDocument(document);
  editor.value = next;
  unsubscribe = next.subscribe(onChange);
  handle = fileHandle;
  fileName.value = name;
  savedDocument.value = unsaved ? null : document;
  state.value = next.state;
  problem.value = null;
  // The draft offered is set aside, and this document's kept from now on.
  offeredDraft.value = null;
  if (!unsaved) dropDraft();
  // Destroyed once the viewport draws the new scene (it redraws as the state changes).
  previous.state.scene?.scene.destroy();
}

/** Discards the draft offered. */
export function discardDraft(): void {
  offeredDraft.value = null;
  dropDraft();
}

/**
 * Marks `document`, from the editor `from`, saved to `saved`. Ignored if another document was
 * opened meanwhile. A download may still be cancelled in the browser's dialog, so its draft is
 * kept; a file written through a handle drops it, unless changes made meanwhile are unsaved.
 */
export function markSaved(saved: SavedFile, document: MascotDocument, from: EditorDocument): void {
  if (editor.peek() !== from) return;
  handle = saved.handle;
  fileName.value = saved.name;
  savedDocument.value = document;
  problem.value = null;
  if (saved.handle && offeredDraft.peek() === null && from.state.document === document) {
    cancelDraft();
    dropDraft();
  }
}

/** The handle of the open document's file, to save in place. */
export function currentHandle(): FileHandle | null {
  return handle;
}
