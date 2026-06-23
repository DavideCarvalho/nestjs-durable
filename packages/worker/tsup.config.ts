import { defineConfig } from 'tsup';

// Dual ESM + CJS publish, matching @dudousxd/nestjs-durable. A NestJS app compiled to CommonJS (SWC's
// default) `require()`s this via nestjs-durable's DurableWorkerModule, so an ESM-only build throws
// ERR_PACKAGE_PATH_NOT_EXPORTED at boot. No decorators in this framework-agnostic core, so esbuild is safe.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  outDir: 'dist',
});
