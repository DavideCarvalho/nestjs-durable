import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The SPA is served under /durable; the controller rewrites this base when mounted elsewhere.
  base: '/durable/',
  // CSS-referenced assets (the kit's bundled fonts) load relative to the stylesheet: the controller
  // rewrites the `/durable/` base in index.html only, so an absolute `/durable/assets/…` font URL
  // inside the CSS would 404 once the console is mounted anywhere else.
  experimental: {
    renderBuiltUrl: (_file, { hostType }) => (hostType === 'css' ? { relative: true } : undefined),
  },
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
