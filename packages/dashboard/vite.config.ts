import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The SPA is served under /durable; the controller rewrites this base when mounted elsewhere.
  base: '/durable/',
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
    rollupOptions: {
      // `index.html` is the production SPA entry. `preview.html` and `bench.html` are additive,
      // standalone mock-data entries: preview for VISUAL verification of the parallel-fan timeline,
      // bench for SCALE — the real `<App/>` against a control plane with tens of thousands of runs,
      // which is the only way to catch the console going unresponsive before an operator does. All
      // three are listed explicitly so `vite build` emits the SPA and compiles both harnesses.
      input: {
        index: resolve(__dirname, 'index.html'),
        preview: resolve(__dirname, 'preview.html'),
        bench: resolve(__dirname, 'bench.html'),
      },
    },
  },
});
