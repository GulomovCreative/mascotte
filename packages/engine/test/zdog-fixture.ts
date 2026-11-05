import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'zdog');

interface Entry {
  input: unknown;
  output: unknown;
}

/**
 * Zdog results for comparison: the numbers the Zdog copy produced while it was in the
 * repository (before #15) are stored in `fixtures/zdog/<name>.json`. The copy itself is gone,
 * so they cannot be regenerated: this is a frozen reference, like the Zdog frame snapshots.
 *
 * Each value is recorded together with the test inputs (rotations, points, shape
 * parameters), and `next` checks them: if a test changes, it fails with a clear error instead
 * of comparing numbers against the wrong reference. Do not change inputs or insert cases in the
 * middle: new checks need their own expected values. After the file runs, a check confirms
 * that every recorded value was used, so a case cannot be removed silently either.
 */
export function zdogFixture(name: string) {
  const stored = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Record<
    string,
    Entry[]
  >;
  const used = new Map<string, number>();
  afterAll(() => {
    for (const [key, list] of Object.entries(stored)) {
      expect(used.get(key) ?? 0, `${name}/${key}: not all Zdog values were used`).toBe(list.length);
    }
  });
  return {
    next<T>(key: string, input: unknown): T {
      const index = used.get(key) ?? 0;
      used.set(key, index + 1);
      const list = stored[key];
      if (!list || index >= list.length) {
        throw new Error(`No Zdog value ${name}/${key}[${index}].`);
      }
      const entry = list[index] as Entry;
      expect(
        entry.input,
        `${name}/${key}[${index}]: test inputs do not match the recorded ones`,
      ).toEqual(JSON.parse(JSON.stringify(input)));
      return entry.output as T;
    },
  };
}
