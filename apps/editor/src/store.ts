import type { MascotDocument } from '@mascotte/format';
import { signal } from '@preact/signals';
import { newDocument } from './files/documents.ts';
import { type Draft, dropDraft, keepDraft, keptDraft } from './files/drafts.ts';
import type { FileHandle } from './files/io.ts';
import { EditorDocument, type EditorState } from './model/editor-document.ts';

/** The document being edited. */
export const editor = signal(new EditorDocument(newDocument('blob')));
/** Its state, a new value after every change. */
export const state = signal<EditorState>(editor.value.state);
/** The file it came from or was saved to: its name, or `null` for a new document. */
export const fileName = signal<string | null>(null);
/** The document as last opened or saved: the open document differs from it while unsaved. */
export const savedDocument = signal<MascotDocument>(editor.value.state.document);
/** What went wrong last (opening, saving), shown until dismissed. */
export const problem = signal<string | null>(null);
/**
 * A draft an earlier visit kept, offered back until it is restored or discarded; while it is on
 * offer no new draft is kept, so a change made meanwhile does not overwrite it.
 */
export const offeredDraft = signal<Draft | null>(keptDraft());

let handle: FileHandle | null = null;
let unsubscribe = editor.value.subscribe(onChange);

function onChange(): void {
  const current = editor.value.state;
  state.value = current;
  if (offeredDraft.value === null) keepDraft(current.document, fileName.value);
}

/** Starts editing `document`, from the file `name` (and `fileHandle`, to save in place). */
export function openDocument(
  document: MascotDocument,
  name: string | null,
  fileHandle: FileHandle | null = null,
): void {
  unsubscribe();
  const next = new EditorDocument(document);
  editor.value = next;
  unsubscribe = next.subscribe(onChange);
  handle = fileHandle;
  fileName.value = name;
  savedDocument.value = document;
  state.value = next.state;
  problem.value = null;
  // Another document opened: the draft offered is set aside, and this one's kept from now on.
  offeredDraft.value = null;
  dropDraft();
}

/** Discards the draft offered. */
export function discardDraft(): void {
  offeredDraft.value = null;
  dropDraft();
}

/** Marks the open document saved, to the file `name`. */
export function markSaved(name: string, fileHandle: FileHandle | null): void {
  handle = fileHandle;
  fileName.value = name;
  savedDocument.value = editor.value.state.document;
  dropDraft();
}

/** The handle of the open document's file, to save in place. */
export function currentHandle(): FileHandle | null {
  return handle;
}
