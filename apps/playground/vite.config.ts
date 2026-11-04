import { defineConfig } from 'vite';

export default defineConfig({
  // Копия Zdog написана в CommonJS, поэтому её нужно предварительно собрать для браузера.
  optimizeDeps: { include: ['@mascotte/zdog-reference'] },
  build: { commonjsOptions: { include: [/src\/core/, /node_modules/] } },
});
