import { defineConfig } from 'tsup';

// ESM-only publish. This package's conformance helpers import `vitest` at module top-level, and
// vitest is ESM-only (it throws on `require()`), so a CJS/`require` build would ship a path that
// can never load. Consumers run these helpers inside vitest (an ESM runtime), so ESM is the only
// honest target. No decorators here, so esbuild is safe.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  outDir: 'dist',
});
