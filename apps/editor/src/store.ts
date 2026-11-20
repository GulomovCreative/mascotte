import type { MascotDocument, PrefabDocument } from '@mascotte/format';
import { PREFABS } from '@mascotte/library';
import { signal } from '@preact/signals';
import { newDocument } from './files/documents.ts';
import { type Draft, dropDraft, keepDraft, keptDraft } from './files/drafts.ts';
import type { FileHandle, SavedFile } from './files/io.ts';
import { setDocumentField } from './model/commands.ts';
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

/** A prefab edited in its own mode: its name, and the document's editor to go back to. */
export interface PrefabMode {
  readonly name: string;
  readonly outer: EditorDocument;
}

/** The prefab being edited in its own mode, or `null` while the document is. */
export const prefabMode = signal<PrefabMode | null>(null);

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
    clearTimeout(pendingDraft);
    keepDraftNow();
  }
});

function onChange(): void {
  state.value = editor.peek().state;
  // A prefab's edits reach the document, and its draft, when its mode ends.
  if (offeredDraft.peek() !== null || prefabMode.peek() !== null) return;
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
  // Built first: if it throws, the open document stays as it was.
  const next = new EditorDocument(document);
  const previous = editor.peek();
  // A prefab being edited is given up with its document.
  const mode = prefabMode.peek();
  if (mode) {
    prefabMode.value = null;
    mode.outer.state.scene?.scene.destroy();
  }
  cancelDraft();
  follow(next);
  handle = fileHandle;
  fileName.value = name;
  savedDocument.value = unsaved ? null : document;
  problem.value = null;
  // The draft offered is set aside, and this document's kept from now on.
  offeredDraft.value = null;
  if (!unsaved) dropDraft();
  // Destroyed once the viewport draws the new scene (it redraws as the state changes).
  previous.state.scene?.scene.destroy();
}

/** Makes `next` the editor the interface shows and edits. */
function follow(next: EditorDocument): void {
  unsubscribe();
  editor.value = next;
  unsubscribe = next.subscribe(onChange);
  state.value = next.state;
}

/** The prefab `name` of `document`: its own, or the library's. */
function prefabOf(document: MascotDocument, name: string): PrefabDocument {
  const own = document.prefabs?.[name];
  const isObject = (value: unknown) => typeof value === 'object' && value !== null;
  if (isObject(own) && isObject(own?.root)) return own as PrefabDocument;
  const library = PREFABS.get(name);
  if (!library) throw new RangeError(`No prefab "${name}".`);
  return library as unknown as PrefabDocument;
}

/**
 * The document a prefab's mode edits: the prefab's tree, parameters and description, shown in
 * `document`'s frame and camera, with its palettes (a prefab's colors take its roles).
 */
export function prefabDocument(document: MascotDocument, name: string): MascotDocument {
  const prefab = prefabOf(document, name);
  return {
    format: document.format,
    version: document.version,
    meta: {
      name,
      ...(prefab.description === undefined ? {} : { description: prefab.description }),
    },
    view: document.view,
    ...(document.camera === undefined ? {} : { camera: document.camera }),
    ...(document.palettes === undefined ? {} : { palettes: document.palettes }),
    ...(prefab.params === undefined ? {} : { params: prefab.params }),
    root: prefab.root,
  };
}

/**
 * Edits the prefab `name` (the document's, or the library's, which the document then gets its own
 * copy of) in its own mode: the tree, the inspector and the viewport show the prefab, until
 * `leavePrefab`.
 */
export function editPrefab(name: string): void {
  if (prefabMode.peek()) throw new Error('A prefab is being edited already.');
  const outer = editor.peek();
  const inner = new EditorDocument(prefabDocument(outer.state.document, name));
  // The document's draft is kept as it stands before the mode starts.
  if (pendingDraft !== undefined) {
    clearTimeout(pendingDraft);
    keepDraftNow();
  }
  prefabMode.value = { name, outer };
  follow(inner);
}

/**
 * Ends the prefab's mode: with `apply`, its edits become the document's prefab, as one step;
 * without, they are dropped.
 */
export function leavePrefab(apply: boolean): void {
  const mode = prefabMode.peek();
  if (!mode) return;
  const inner = editor.peek();
  const { document: edited, canUndo } = inner.state;
  prefabMode.value = null;
  follow(mode.outer);
  inner.state.scene?.scene.destroy();
  if (!apply || !canUndo) return;
  const prefab: PrefabDocument = {
    ...(edited.meta.description === undefined ? {} : { description: edited.meta.description }),
    ...(edited.params === undefined ? {} : { params: edited.params }),
    root: edited.root,
  };
  mode.outer.execute(setDocumentField(['prefabs', mode.name], prefab));
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

/**
 * Runs `task`, showing what goes wrong in the menu bar after `what` ("Could not open"); the
 * error goes to the console too, with its stack and cause.
 */
export async function attempt(what: string, task: () => Promise<void> | void): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(error);
    problem.value = `${what}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
