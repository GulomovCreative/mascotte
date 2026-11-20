import type { MascotDocument, PrefabDocument } from '@mascotte/format';
import { signal } from '@preact/signals';
import { newDocument } from './files/documents.ts';
import { type Draft, dropDraft, keepDraft, keptDraft } from './files/drafts.ts';
import type { FileHandle, SavedFile } from './files/io.ts';
import { setDocumentField } from './model/commands.ts';
import { EditorDocument, type EditorState } from './model/editor-document.ts';
import { prefabDefinition } from './model/prefabs.ts';

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

/** The document as it stands, with the edits of a prefab being edited in its mode. */
function currentDocument(): MascotDocument {
  const mode = prefabMode.peek();
  if (!mode) return editor.peek().state.document;
  const { document } = mode.outer.state;
  return editor.peek().state.canUndo ? applied(mode).run(document, null).document : document;
}

/** Whether the open document has changes no file holds (a prefab's mode's edits among them). */
export const isUnsaved = () => {
  const mode = prefabMode.value;
  if (!mode) return state.value.document !== savedDocument.value;
  return state.value.canUndo || mode.outer.state.document !== savedDocument.value;
};

let handle: FileHandle | null = null;
let unsubscribe = editor.value.subscribe(onChange);

// Drafts are kept a moment after the last change, not on every step of a drag.
const DRAFT_DELAY = 500;
let pendingDraft: ReturnType<typeof setTimeout> | undefined;

function keepDraftNow(): void {
  pendingDraft = undefined;
  // Run from a timer or as the page goes: a failure is said, not thrown where nothing hears it.
  try {
    keepDraft(currentDocument(), fileName.peek());
  } catch (error) {
    console.error(error);
    problem.value = `Could not keep a draft: ${error instanceof Error ? error.message : String(error)}`;
  }
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

/**
 * The document a prefab's mode edits: the prefab's tree, parameters and description, shown in
 * `document`'s frame and camera, with its palettes (a prefab's colors take its roles).
 */
export function prefabDocument(document: MascotDocument, name: string): MascotDocument {
  const prefab = prefabDefinition(document, name);
  if (!prefab) {
    throw new RangeError(
      Object.hasOwn(document.prefabs ?? {}, name)
        ? `The prefab "${name}" has no root to edit (see its issues).`
        : `No prefab "${name}".`,
    );
  }
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
 * Edits the prefab `name` (the document's, or the library's, which the document gets its own copy
 * of when the mode ends with changes) in its own mode: the tree, the inspector and the viewport
 * show the prefab, until `leavePrefab`. Meanwhile the draft keeps the document with the prefab as
 * it is being edited.
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

/** The command that makes the prefab mode's edits the document's prefab. */
function applied(mode: PrefabMode) {
  const edited = editor.peek().state.document;
  const prefab: PrefabDocument = {
    ...(edited.meta.description === undefined ? {} : { description: edited.meta.description }),
    ...(edited.params === undefined ? {} : { params: edited.params }),
    root: edited.root,
  };
  return setDocumentField(['prefabs', mode.name], prefab);
}

/**
 * Ends the prefab's mode: with `apply`, its edits become the document's prefab, as one step;
 * without, they are dropped. If applying them throws, the mode goes on, its edits kept.
 */
export function leavePrefab(apply: boolean): void {
  const mode = prefabMode.peek();
  if (!mode) return;
  const inner = editor.peek();
  // Applied first: the mode ends only once its edits are the document's.
  // упрощение: id, переименованные внутри префаба, не переименовываются в слотах, дорожках и
  // ограничениях документа (`экземпляр-id`); следовать им — когда понадобится (с таймлайном, #93).
  if (apply && inner.state.canUndo) mode.outer.execute(applied(mode));
  prefabMode.value = null;
  follow(mode.outer);
  inner.state.scene?.scene.destroy();
  // The draft follows the document as it now is.
  onChange();
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
