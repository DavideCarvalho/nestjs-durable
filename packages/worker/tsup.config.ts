import { defineConfig } from 'tsup';

// ESM-only publish, matching the sibling packages. No decorators in this framework-agnostic core,
// so esbuild is safe.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  outDir: 'dist',
});
