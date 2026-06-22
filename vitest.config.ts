import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Resolve workspace packages to their TS source so cross-package tests never run against a
  // stale `dist/`. Production builds still go through `tsc` per package.
  resolve: {
    alias: {
      '@dudousxd/nestjs-durable-core': pkg('core'),
      '@dudousxd/nestjs-durable-testing': pkg('testing'),
      '@dudousxd/nestjs-durable-transport-event-emitter': pkg('transport-event-emitter'),
      '@dudousxd/nestjs-durable': pkg('nestjs'),
      '@dudousxd/durable-worker': pkg('worker'),
    },
  },
  plugins: [
    // Emit `emitDecoratorMetadata` so NestJS DI works under Vitest (esbuild can't do it).
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    // Generate the store-prisma SQLite test client once (pre-workers) so it never goes stale against
    // the current schema. See vitest.globalsetup.ts.
    globalSetup: ['./vitest.globalsetup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/src/**/*.{test,spec}.ts', 'examples/*/src/**/*.{test,spec}.ts'],
    // `*.db.spec.ts` boot real Postgres/MySQL via testcontainers — run them only via `pnpm test:db`
    // (vitest.db.config.ts), never in the default sqlite/in-memory `pnpm test`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.{test,spec}.ts', 'packages/*/src/index.ts'],
    },
  },
});
