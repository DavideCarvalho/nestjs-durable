// The dashboard SERVER is a decorator-bearing NestJS module (@Module/@Injectable/@Inject/
// controllers), so it builds through the shared SWC-decorator tsup config to preserve
// `design:paramtypes` for DI — and it MUST emit dual ESM + CJS.
//
// Why dual matters here: a CJS host (e.g. a NestJS app built with `nest build` → CommonJS) that
// `require`s this package while also `require`ing `@dudousxd/nestjs-durable` would otherwise load an
// ESM-only dashboard. ESM and CJS are separate module instances, so the dashboard would import a
// SECOND copy of `@dudousxd/nestjs-durable-core` while `DurableModule` holds the CJS copy. The DI
// tokens survive that split (they're `Symbol.for`), but `WorkflowEngine` — a CLASS used as a token —
// does not: the two copies expose two distinct class objects, and `DashboardService`'s
// `WorkflowEngine` injection no longer matches `DurableModule`'s provider → boot fails with
// "Nest can't resolve dependencies of the DashboardService". Shipping CJS lets a CJS host resolve
// the dashboard (and thus core) in the same module system as the rest of the durable packages.
//
// `import.meta.url` (durable-ui.controller locates the SPA via `new URL('../spa', import.meta.url)`)
// is shimmed in the CJS output. The Vite SPA build (dist/spa) and the client types build
// (dist/client) are driven separately by the package's `build` script.
import { decoratorDualConfig } from '../../scripts/tsup-decorator.mjs';

export default decoratorDualConfig(
  ['@dudousxd/nestjs-durable-core', '@nestjs/common', '@nestjs/core', 'rxjs', 'reflect-metadata'],
  {
    entry: ['src/server/index.ts'],
    outDir: 'dist/server',
    importMetaUrlShim: true,
    tsconfig: 'tsconfig.server.json',
  },
);
