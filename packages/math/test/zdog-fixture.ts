import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'zdog');

/**
 * Результаты Zdog для сравнения: числа, которые выдала копия Zdog, пока она была в
 * репозитории (до #15), сохранены в `fixtures/zdog/<name>.json`. Сама копия удалена,
 * поэтому пересоздать их нельзя — это замороженный эталон, как снимки кадров Zdog.
 * В каждом тесте значения берутся в порядке вызовов `next`.
 */
export function zdogFixture(name: string) {
  const stored = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Record<
    string,
    unknown[]
  >;
  const used = new Map<string, number>();
  return {
    next<T>(key: string): T {
      const index = used.get(key) ?? 0;
      used.set(key, index + 1);
      const list = stored[key];
      if (!list || index >= list.length) {
        throw new Error(`Нет значения Zdog ${name}/${key}[${index}].`);
      }
      return list[index] as T;
    },
  };
}
