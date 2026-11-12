import { rmSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Dual ESM + CJS publish (matches `core` and the ecosystem standard). ESM is the primary build
// (index.js + index.d.ts); CJS is the `require` fallback (index.cjs + index.d.cts). The conditional
// `exports` map in package.json points each consumer condition at the matching pair.
// The ESM and CJS configs build in parallel, and tsup's DTS step deletes every `.d.*` in `outDir`
// when `clean` is set, so a cleaning config can remove the other's `index.d.cts` after it was
// written. Clean once, here, before either build starts.
rmSync('dist', { recursive: true, force: true });

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'delivery/index': 'src/delivery/index.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry: { index: 'src/index.ts', 'delivery/index': 'src/delivery/index.ts' },
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
