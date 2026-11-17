import type { MascotDocument } from '@mascotte/format';

/** A draft of the open document, kept in the browser's storage. */
export interface Draft {
  /** The document, as JSON; read with `readDocument`, which migrates it. */
  readonly text: string;
  /** When it was kept (milliseconds since the epoch). */
  readonly savedAt: number;
  /** The file it came from, if any. */
  readonly fileName: string | null;
}

const KEY = 'mascotte-editor-draft';

/** The storage drafts go to: the browser's, or none where it cannot be used. */
function storage(given?: Storage | null): Storage | null {
  if (given !== undefined) return given;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Keeps a draft of `document`. A convenience, not storage: where the browser refuses (private
 * mode, a full store), it is not kept, and the document is still the file.
 */
export function keepDraft(
  document: MascotDocument,
  fileName: string | null,
  now = Date.now(),
  store?: Storage | null,
): void {
  const target = storage(store);
  if (!target) return;
  try {
    const draft: Draft = { text: JSON.stringify(document), savedAt: now, fileName };
    target.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Not kept: see above.
  }
}

/** The draft kept, or `null` (none, or one that cannot be read). */
export function keptDraft(store?: Storage | null): Draft | null {
  const target = storage(store);
  if (!target) return null;
  try {
    const raw = target.getItem(KEY);
    if (raw === null) return null;
    const draft = JSON.parse(raw) as Partial<Draft>;
    if (typeof draft.text !== 'string' || typeof draft.savedAt !== 'number') return null;
    return { text: draft.text, savedAt: draft.savedAt, fileName: draft.fileName ?? null };
  } catch {
    return null;
  }
}

/** Forgets the draft. */
export function dropDraft(store?: Storage | null): void {
  try {
    storage(store)?.removeItem(KEY);
  } catch {
    // Nothing to forget.
  }
}
