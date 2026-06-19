// Shared tsup config for DECORATOR-bearing packages (NestJS DI, TypeORM/MikroORM entities).
//
// Plain esbuild does NOT emit `emitDecoratorMetadata`, so `design:paramtypes` / `design:type`
// vanish — NestJS DI params collapse to `Object` and ORM column types can't be inferred. We route
// the TS->JS transform through SWC (which DOES emit decorator metadata), via an esbuild plugin,
// while tsup still drives the dual ESM+CJS emit and the .d.ts/.d.cts declarations.
//
// `.d.ts` is produced by tsup's own DTS step (the TS compiler), unaffected by the JS transform.
import { readFileSync } from 'node:fs';
import { transform } from '@swc/core';
import { defineConfig } from 'tsup';

/** esbuild plugin: transpile .ts via SWC with legacy decorators + metadata. */
const swcDecoratorPlugin = {
  name: 'swc-decorator-metadata',
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      const source = readFileSync(args.path, 'utf8');
      const { code, map } = await transform(source, {
        filename: args.path,
        sourceMaps: true,
        jsc: {
          target: 'es2022',
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          // Preserve ESM import/export so esbuild can still resolve/bundle and emit either format.
          keepClassNames: true,
        },
        module: { type: 'es6' },
      });
      return {
        contents: `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map ?? '{}').toString('base64')}`,
        loader: 'js',
      };
    });
  },
};

/**
 * @param {string[]} external - packages to leave unbundled (deps + peers).
 * @param {object} [opts]
 * @param {string[]} [opts.entry] - tsup entry points. Defaults to the package root `src/index.ts`.
 * @param {string} [opts.outDir] - output dir. Defaults to `dist`.
 * @param {boolean} [opts.importMetaUrlShim] - shim `import.meta.url` in the CJS output (define it
 *   from `__filename`). Needed when a module reads `import.meta.url` at runtime (e.g. to locate
 *   sibling assets) and must also work when `require`d from a CJS host. Mirrors the core package.
 */
export function decoratorDualConfig(external = [], opts = {}) {
  const { entry = ['src/index.ts'], outDir = 'dist', importMetaUrlShim = false, tsconfig } = opts;
  const common = {
    entry,
    splitting: false,
    sourcemap: true,
    outDir,
    external,
    esbuildPlugins: [swcDecoratorPlugin],
    // tsup's DTS step compiles against this tsconfig. Point it at one with real `compilerOptions`
    // (decorators + NodeNext) — a solution-style root `tsconfig.json` (only `references`) leaves the
    // DTS build without `experimentalDecorators`/module resolution and it fails (TS1206 / TS2792).
    ...(tsconfig ? { tsconfig } : {}),
  };
  const cjsShim = importMetaUrlShim
    ? {
        banner: {
          js: `const __importMetaUrl = require('url').pathToFileURL(__filename).href;`,
        },
        esbuildOptions(options) {
          options.define = { ...options.define, 'import.meta.url': '__importMetaUrl' };
        },
      }
    : {};
  return defineConfig([
    { ...common, format: ['esm'], dts: true, clean: true },
    { ...common, format: ['cjs'], dts: true, clean: false, ...cjsShim },
  ]);
}
