import { defineConfig } from 'vite';

export default defineConfig({
  // Копия Zdog написана в CommonJS, а связанные пакеты workspace dev-сервер не собирает
  // заранее, поэтому её нужно включить в предварительную сборку явно.
  optimizeDeps: { include: ['@mascotte/zdog-reference'] },
});
