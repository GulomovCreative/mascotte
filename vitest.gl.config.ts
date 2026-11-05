import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { glCommands } from './reference/src/gl-snapshot.ts';

/*
 * Тесты WebGL2 в настоящем браузере: Chromium без интерфейса с программным рендером
 * SwiftShader, чтобы кадры не зависели от видеокарты. Запуск — `pnpm test:gl`.
 */
export default defineConfig({
  // Копия Zdog в эталонных сценах написана в CommonJS: её нужно собрать заранее, как в playground.
  optimizeDeps: { include: ['@mascotte/zdog-reference'] },
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
