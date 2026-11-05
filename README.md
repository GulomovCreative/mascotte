# Mascotte

Библиотека для анимированных псевдо-3D маскотов. Строит фигуры из простых примитивов в pseudo-3D на canvas или SVG и анимирует их.

Ядро рендера основано на [Zdog](https://github.com/metafizzy/zdog) от Metafizzy (MIT). Код скопирован в `src/core/` (коммит upstream `dde8684`). Подробности в [NOTICE](NOTICE).

## Статус

Ранняя стадия. Копия ядра Zdog служит справочником и эталоном картинки. Новое ядро пишется с нуля, совместимость с API Zdog не планируется.

## План

Цели, архитектура и этапы работы описаны в [docs/PLAN.md](docs/PLAN.md). Коротко:

- основной бэкенд — Canvas 2D;
- маскоты собираются в визуальном редакторе и хранятся как JSON-документы;
- архетипы, слоты рига и общая библиотека анимаций позволяют делать разных маскотов без нового кода.

## Разработка

Нужны Node.js 24+ и pnpm 12.

```sh
pnpm install
pnpm dev               # playground на http://localhost:5173
pnpm test              # тесты, включая сравнение снимков кадров
pnpm test:gl           # тесты WebGL2 в Chromium без интерфейса (SwiftShader)
pnpm typecheck         # проверка типов
pnpm lint              # линтер и форматирование (Biome)
pnpm format            # исправить форматирование
pnpm build             # сборка playground
```

Структура:

- `packages/` — пакеты движка: `math`, `engine`, `format`, `player`;
- `apps/playground` — примеры и отладка: сцены на WebGL2 и Canvas 2D и эталоны Zdog для сравнения;
- `reference/` — эталонные сцены в двух версиях (копия Zdog и новое ядро) и снимки кадров Zdog в `reference/snapshots/`; кадры нового ядра сравниваются с ними;
- `src/core/` — неизменённая копия ядра Zdog.

Если тест снимка упал, фактический кадр и карта отличий лежат в `reference/test/__diff__/` (для WebGL — в `reference/test/__diff__/gl/`). Снимки создаются и обновляются только командами `pnpm snapshots:update` и `pnpm snapshots:update:gl`, обычный прогон тестов их не пишет. В CI обновление запрещено.

Тестам WebGL нужен Chromium для Playwright: один раз выполните `pnpm exec playwright install --only-shell chromium` (в Linux можно добавить `--with-deps`, чтобы поставить системные библиотеки). Снимки WebGL лежат в `reference/snapshots/gl/` и привязаны к версии Chromium, которую задаёт `playwright` в `pnpm-lock.yaml`: после её обновления снимки может понадобиться пересоздать.

## Лицензия

MIT, см. [LICENSE](LICENSE).
