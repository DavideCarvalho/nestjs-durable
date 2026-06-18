import { defineConfig } from 'tsup';

// Dual ESM + CJS publish (matches `core` and the ecosystem standard). ESM is the primary build
// (index.js + index.d.ts); CJS is the `require` fallback (index.cjs + index.d.cts). The conditional
// `exports` map in package.json points each consumer condition at the matching pair. This package
// uses no decorators, so esbuild (which can't emit `emitDecoratorMetadata`) is safe here.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    // Emit a CJS-flavoured declaration (index.d.cts) so the `require` condition resolves to types
    // matching the CommonJS output under NodeNext.
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
