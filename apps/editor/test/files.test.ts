import { ARCHETYPES } from '@mascotte/library';
import { describe, expect, it } from 'vitest';
import {
  documentText,
  newDocument,
  REFERENCE_DOCUMENTS,
  readDocumentText,
} from '../src/files/documents.ts';
import { dropDraft, keepDraft, keptDraft } from '../src/files/drafts.ts';
import { check } from '../src/model/editor-document.ts';

/** A storage in memory, as the browser's. */
function memory(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => items.delete(key),
    setItem: (key, value) => items.set(key, String(value)),
  } as Storage;
}

describe('editor files', () => {
  it.each([...ARCHETYPES.keys()])('makes a valid new %s with every slot it requires', (name) => {
    const document = newDocument(name);
    const checked = check(document);
    expect(checked.issues).toEqual([]);
    const archetype = ARCHETYPES.get(name);
    for (const slot of archetype?.slots ?? []) {
      expect(document.rig?.slots?.[slot], slot).toBeDefined();
    }
    expect(() => newDocument('dragon')).toThrow(/No archetype/);
  });

  it.each([...REFERENCE_DOCUMENTS])('saves %s and reads it back the same', (_, make) => {
    const document = make();
    const text = documentText(document);
    expect(text.endsWith('}\n')).toBe(true);
    expect(readDocumentText(text)).toEqual(document);
  });

  it('refuses a file that is not a mascot document, and reads one with issues for the editor to show', () => {
    expect(() => readDocumentText('{')).toThrow(/not JSON/);
    expect(() => readDocumentText('{"format":"other"}')).toThrow();
    const document = newDocument('blob');
    expect(() => readDocumentText(JSON.stringify({ ...document, root: 5 }))).toThrow(/root/);
    // A slot bound to no node: an issue, read all the same.
    const broken = { ...document, rig: { slots: { ...document.rig?.slots, body: 'gone' } } };
    const read = readDocumentText(JSON.stringify(broken));
    expect(read).toEqual(broken);
    expect(check(read).issues.length).toBeGreaterThan(0);
  });

  it('keeps a draft, gives it back and forgets it, and goes on without storage', () => {
    const store = memory();
    const document = newDocument('blob');
    keepDraft(document, 'blob.json', 1000, store);
    const draft = keptDraft(store);
    expect(draft).toEqual({ text: JSON.stringify(document), savedAt: 1000, fileName: 'blob.json' });
    expect(readDocumentText(draft?.text ?? '')).toEqual(document);
    dropDraft(store);
    expect(keptDraft(store)).toBeNull();
    // No storage, or one that refuses: nothing kept, nothing thrown.
    keepDraft(document, null, 1, null);
    const full = memory();
    full.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    expect(() => keepDraft(document, null, 1, full)).not.toThrow();
    // A draft that cannot be read is none.
    store.setItem('mascotte-editor-draft', '{"text": 5}');
    expect(keptDraft(store)).toBeNull();
  });
});
