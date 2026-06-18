import { defineConfig } from 'tsup';

// Dual ESM + CJS publish (matches the ecosystem standard — see nestjs-codegen / nestjs-inertia).
// ESM is the primary build (emits index.js + index.d.ts); CJS is the `require` fallback (index.cjs +
// index.d.cts). The conditional `exports` map in package.json points each consumer condition at the
// matching pair. Core uses no decorators, so esbuild (no emitDecoratorMetadata) is safe here — the
// decorator-bearing packages (`nestjs`, `store-typeorm`, `store-mikro-orm`) route their JS transform
// through SWC to preserve `design:paramtypes`/`design:type`; see scripts/tsup-decorator.mjs.
const external = ['cron-parser', 'reflect-metadata', 'zod'];

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
  },
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    // Emit a CJS-flavoured declaration (index.d.cts) so the `require` condition resolves to types
    // matching the CommonJS output under NodeNext, instead of masquerading the ESM index.d.ts.
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    // Shim `import.meta.url` for the CJS output: scheduler.ts uses createRequire(import.meta.url)
    // to lazily load the optional cron-parser peer dep in both formats.
    banner: {
      js: `const __importMetaUrl = require('url').pathToFileURL(__filename).href;`,
    },
    esbuildOptions(options) {
      options.define = {
        ...options.define,
        'import.meta.url': '__importMetaUrl',
      };
    },
    external,
  },
]);
