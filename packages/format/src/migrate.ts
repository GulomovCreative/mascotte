import { DocumentError, FORMAT } from './document.ts';

/** Upgrades a document of one version to the next one; it may change the object it gets. */
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
 * format's own). Throws a `DocumentError` for something that is not a mascot document, or
 * one written by a newer version.
 */
export function migrate(
  value: unknown,
  migrations: readonly Migration[] = MIGRATIONS,
): Record<string, unknown> {
  const current = migrations.length + 1;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DocumentError([{ path: '', message: 'expected a document object.' }]);
  }
  let document = value as Record<string, unknown>;
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
    document = { ...migration(document), version: from + 1 };
  }
  return document;
}
