import { rmSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Dual ESM + CJS publish (matches the ecosystem standard). No decorators here, so esbuild is safe.
// The ESM and CJS configs build in parallel, and tsup's DTS step deletes every `.d.*` in `outDir`
// when `clean` is set, so a cleaning config can remove the other's `index.d.cts` after it was
// written. Clean once, here, before either build starts.
rmSync(new URL('./dist/', import.meta.url), { recursive: true, force: true });

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
