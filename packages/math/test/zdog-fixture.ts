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
 * Результаты Zdog для сравнения: числа, которые выдала копия Zdog, пока она была в
 * репозитории (до #15), сохранены в `fixtures/zdog/<name>.json`. Сама копия удалена,
 * поэтому пересоздать их нельзя — это замороженный эталон, как снимки кадров Zdog.
 *
 * Каждое значение записано вместе с входными данными теста (повороты, точки, параметры
 * фигур), и `next` сверяет их: если тест изменить, он упадёт с понятной ошибкой, а не
 * сравнит числа с чужим эталоном. Менять входы и вставлять случаи в середину нельзя —
 * для новых проверок нужны собственные ожидаемые значения. В конце файла проверяется,
 * что использованы все записанные значения, так что убрать случай молча тоже не выйдет.
 */
export function zdogFixture(name: string) {
  const stored = JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Record<
    string,
    Entry[]
  >;
  const used = new Map<string, number>();
  afterAll(() => {
    for (const [key, list] of Object.entries(stored)) {
      expect(used.get(key) ?? 0, `${name}/${key}: использованы не все значения Zdog`).toBe(
        list.length,
      );
    }
  });
  return {
    next<T>(key: string, input: unknown): T {
      const index = used.get(key) ?? 0;
      used.set(key, index + 1);
      const list = stored[key];
      if (!list || index >= list.length) {
        throw new Error(`Нет значения Zdog ${name}/${key}[${index}].`);
      }
      const entry = list[index] as Entry;
      expect(
        entry.input,
        `${name}/${key}[${index}]: входные данные теста не совпадают с записанными`,
      ).toEqual(JSON.parse(JSON.stringify(input)));
      return entry.output as T;
    },
  };
}
