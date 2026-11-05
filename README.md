# Mascotte

A library for animated stylized 3D mascots. It builds shapes from simple primitives and draws them with WebGL2 (or Canvas 2D as a fallback) in a flat style with thick rounded strokes.

The style and primitive geometry come from [Zdog](https://github.com/metafizzy/zdog) by Metafizzy (MIT). The core is written from scratch. The Zdog copy used to compare images has been removed; its frames and numbers remain as test references. See [NOTICE](NOTICE) for details.

## Status

Early stage. The new core draws the reference scenes the same way Zdog does. Compatibility with the Zdog API is not planned.

## Plan

Goals, architecture and stages of work are described in [docs/PLAN.md](docs/PLAN.md). In short:

- the main backend is WebGL2 with per-pixel depth; Canvas 2D is the fallback and is used for export;
- mascots are assembled in a visual editor and stored as JSON documents;
- archetypes, rig slots and a shared animation library make it possible to build different mascots without new code.

## Development

Requires Node.js 24+ and pnpm 12.

```sh
pnpm install
pnpm dev               # playground at http://localhost:5173
pnpm test              # tests, including frame snapshot comparison
pnpm test:gl           # WebGL2 tests in headless Chromium (SwiftShader)
pnpm typecheck         # type checking
pnpm lint              # linter and formatting (Biome)
pnpm format            # fix formatting
pnpm build             # build the playground
```

Structure:

- `packages/`: engine packages `math`, `engine`, `format`, `player`;
- `apps/playground`: examples and debugging, WebGL2 and Canvas 2D scenes and a benchmark;
- `reference/`: reference scenes on the new core, scenes for the new core only, and the benchmark; frame snapshots are in `reference/snapshots/`: Canvas 2D, WebGL (`gl/`) and frozen Zdog frames (`zdog/`) that the reference scenes are compared against.

If a snapshot test fails, the actual frame and the diff map are in `reference/test/__diff__/` (for WebGL, in `reference/test/__diff__/gl/`). Snapshots are created and updated only by `pnpm snapshots:update` and `pnpm snapshots:update:gl`; a regular test run does not write them. Updating is disabled in CI. The Zdog frames in `reference/snapshots/zdog/` are never regenerated, since the Zdog copy no longer exists.

WebGL tests need Chromium for Playwright: run `pnpm exec playwright install --only-shell chromium` once (on Linux you can add `--with-deps` to install system libraries). WebGL snapshots are in `reference/snapshots/gl/` and are tied to the Chromium version set by `playwright` in `pnpm-lock.yaml`. After it is updated, the snapshots may need to be regenerated.

## License

MIT, see [LICENSE](LICENSE).
