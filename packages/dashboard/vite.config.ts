import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The SPA is served under /durable; the controller rewrites this base when mounted elsewhere.
  base: '/durable/',
  build: { outDir: 'dist/spa', emptyOutDir: true },
});
