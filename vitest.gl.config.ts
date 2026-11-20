import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { glCommands } from './reference/src/gl-snapshot.ts';

/** Headless Chromium with the SwiftShader software renderer, so frames do not depend on the GPU. */
const browser = () => ({
  enabled: true,
  headless: true,
  provider: playwright({
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  }),
  instances: [{ browser: 'chromium' as const }],
  commands: glCommands,
});

/*
 * Tests in a real browser: WebGL2 frames and the editor's interface. Run with `pnpm test:gl`.
 * The editor's test files run one at a time: they share the page's origin, and so
 * the storage that keeps the editor's draft.
 */
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'gl', include: ['reference/test-gl/**/*.test.ts'], browser: browser() } },
      {
        test: {
          name: 'editor',
          include: ['apps/editor/test/**/*.test.tsx'],
          browser: browser(),
          fileParallelism: false,
        },
      },
    ],
  },
});
