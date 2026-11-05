import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { glCommands } from './reference/src/gl-snapshot.ts';

/*
 * WebGL2 tests in a real browser: headless Chromium with the SwiftShader software renderer,
 * so frames do not depend on the GPU. Run with `pnpm test:gl`.
 */
export default defineConfig({
  test: {
    include: ['reference/test-gl/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          args: [
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
          ],
        },
      }),
      instances: [{ browser: 'chromium' }],
      commands: glCommands,
    },
  },
});
