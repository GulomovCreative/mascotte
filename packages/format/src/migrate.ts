import { DocumentError, FORMAT } from './document.ts';

/**
 * Upgrades a document of one version to the next one; it may change the object it gets (a copy
 * of the caller's) and need not set `version`, which `migrate` does.
 */
export type Migration = (document: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations in order: the first upgrades version 1 to 2, and so on. The current version is
 * one past the last of them.
 */
export const MIGRATIONS: readonly Migration[] = [];

/** The version documents are written in. */
export const VERSION = MIGRATIONS.length + 1;

/**
 * Brings a parsed document up to the current version of `migrations` (by default the
 * format's own), working on a copy. Throws a `DocumentError` for something that is not a
 * mascot document, a version that is not a whole number from 1, one written by a newer
 * version, or a migration that fails.
 */
export function migrate(
  value: unknown,
  migrations: readonly Migration[] = MIGRATIONS,
): Record<string, unknown> {
  const current = migrations.length + 1;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DocumentError([{ path: '', message: 'expected a document object.' }]);
  }
  let document: Record<string, unknown>;
  try {
    document = structuredClone(value) as Record<string, unknown>;
  } catch (error) {
    const message = 'the document holds values JSON cannot (functions, say).';
    throw new DocumentError([{ path: '', message }], { cause: error });
  }
  if (document.format !== FORMAT) {
    throw new DocumentError([
      { path: 'format', message: `expected "${FORMAT}": this is not a mascot document.` },
    ]);
  }
  const { version } = document;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new DocumentError([
      { path: 'version', message: `expected a whole number from 1, got ${String(version)}.` },
    ]);
  }
  if (version > current) {
    throw new DocumentError([
      {
        path: 'version',
        message: `the document has version ${version}, newer than ${current} this reader knows.`,
      },
    ]);
  }
  for (let from = version; from < current; from++) {
    const migration = migrations[from - 1] as Migration;
    const where = `migrating from version ${from} to ${from + 1}`;
    let next: unknown;
    try {
      next = migration(document);
    } catch (error) {
      const message = `${where} failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new DocumentError([{ path: 'version', message }], { cause: error });
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new DocumentError([{ path: 'version', message: `${where} gave no document.` }]);
    }
    document = { ...(next as Record<string, unknown>), version: from + 1 };
  }
  return document;
}
