import type { MascotDocument } from '@mascotte/format';
import { documentText, readDocumentText } from './documents.ts';

/** The parts of the File System Access API the editor uses (not every browser has them). */
interface FileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{
    write(data: string): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}
interface FilePickers {
  showOpenFilePicker?(options: object): Promise<FileHandle[]>;
  showSaveFilePicker?(options: object): Promise<FileHandle>;
}

const TYPES = [{ description: 'Mascot document', accept: { 'application/json': ['.json'] } }];

/** A document opened from a file, with the file's name and handle (to save in place). */
export interface OpenedFile {
  readonly document: MascotDocument;
  readonly name: string;
  readonly handle: FileHandle | null;
}

/** Where a document was saved: the file's name and handle, if the browser gives one. */
export interface SavedFile {
  readonly name: string;
  readonly handle: FileHandle | null;
}

const pickers = () => globalThis as unknown as FilePickers;

/** Whether the user closed a picker: not an error, nothing happens. */
function cancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Asks for a file with the browser's file input, or `null` if none is chosen. The input is in
 * the page while it is open (some browsers do not report a detached one). Browsers without the
 * `cancel` event leave the promise pending when the user cancels: nothing happens, as wanted.
 */
function pickWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.hidden = true;
    const settle = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => settle(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => settle(null), { once: true });
    document.body.append(input);
    input.click();
  });
}

/**
 * Opens a document the user picks: through the File System Access API where the browser has it
 * (so it can be saved in place), else a file input. Read with migration and validation; throws
 * a `DocumentError` for a file that is not a mascot document. `null` if the user cancels.
 */
export async function openFile(): Promise<OpenedFile | null> {
  const show = pickers().showOpenFilePicker;
  if (show) {
    let handle: FileHandle;
    try {
      [handle] = (await show.call(globalThis, { types: TYPES })) as [FileHandle];
    } catch (error) {
      if (cancelled(error)) return null;
      throw error;
    }
    const file = await handle.getFile();
    return { document: readDocumentText(await file.text()), name: handle.name, handle };
  }
  const file = await pickWithInput();
  if (!file) return null;
  return { document: readDocumentText(await file.text()), name: file.name, handle: null };
}

/**
 * Writes `document` to `handle`; a write that fails is aborted, leaving the file as it was. A
 * file opened for reading asks for leave to write: refused, it says to save elsewhere.
 */
async function write(handle: FileHandle, document: MascotDocument): Promise<void> {
  let writable: Awaited<ReturnType<FileHandle['createWritable']>>;
  try {
    writable = await handle.createWritable();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error(`Not allowed to write ${handle.name}: use Save as… to save elsewhere.`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await writable.write(documentText(document));
    await writable.close();
  } catch (error) {
    await writable.abort?.().catch(() => undefined);
    throw error;
  }
}

/** Hands `document` to the browser as a download named `name`. */
function download(document: MascotDocument, name: string): void {
  const url = URL.createObjectURL(new Blob([documentText(document)], { type: 'application/json' }));
  const link = globalThis.document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Some browsers drop a download whose URL goes at once.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Saves `document`: in place to `handle` if given, else to a file the user picks (File System
 * Access API), else as a download named `name`. `null` if the user cancels the picker.
 */
export async function saveFile(
  document: MascotDocument,
  name: string,
  handle: FileHandle | null,
): Promise<SavedFile | null> {
  if (handle) {
    await write(handle, document);
    return { name: handle.name, handle };
  }
  const show = pickers().showSaveFilePicker;
  if (show) {
    let picked: FileHandle;
    try {
      picked = await show.call(globalThis, { suggestedName: name, types: TYPES });
    } catch (error) {
      if (cancelled(error)) return null;
      throw error;
    }
    await write(picked, document);
    return { name: picked.name, handle: picked };
  }
  download(document, name);
  return { name, handle: null };
}

export type { FileHandle };
