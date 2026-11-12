import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * The REAL-engine test matrix: runs ONLY the `*.db.spec.ts` suites, which boot Postgres + MySQL via
 * testcontainers and run the shared StateStore contract against them. Invoked by `pnpm test:db`.
 *
 * Standalone (not a merge of vitest.config.ts) so it can OVERRIDE `include`/`exclude` cleanly —
 * vitest's mergeConfig concatenates those arrays, which would otherwise re-add the base globs (run
 * everything) and re-apply the base's `*.db.spec.ts` exclusion (skip the very files we want).
 *
 * Long timeouts because a cold container pull + boot dominates the first run; the contract cases
 * themselves are fast once the engine is up.
 */
export default defineConfig({
  // Resolve workspace packages to their TS source (same as the base config).
  resolve: {
    alias: {
      // Before the bare package name: an alias key also matches `<key>/...`.
      '@dudousxd/nestjs-durable-diagnostics/delivery': fileURLToPath(
        new URL('./packages/diagnostics/src/delivery/index.ts', import.meta.url),
      ),
      '@dudousxd/nestjs-durable-diagnostics': pkg('diagnostics'),
      '@dudousxd/nestjs-durable-dashboard': fileURLToPath(
        new URL('./packages/dashboard/src/server/index.ts', import.meta.url),
      ),
      '@dudousxd/nestjs-durable-store-typeorm': pkg('store-typeorm'),
      '@dudousxd/nestjs-durable-core': pkg('core'),
      '@dudousxd/nestjs-durable-testing': pkg('testing'),
      '@dudousxd/nestjs-durable-transport-event-emitter': pkg('transport-event-emitter'),
      '@dudousxd/nestjs-durable': pkg('nestjs'),
      '@dudousxd/nestjs-durable-transport-db': pkg('transport-db'),
      '@dudousxd/nestjs-durable-transport-bullmq': pkg('transport-bullmq'),
      '@dudousxd/durable-worker': pkg('worker'),
    },
  },
  plugins: [
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
    server: {
      deps: {
        // `transports.durable()` imports `@dudousxd/nestjs-durable-diagnostics/delivery` lazily from
        // inside diagnostics. Inlined, that import goes through the aliases above (the TS source)
        // instead of Node resolving the package's unbuilt `dist/`.
        inline: ['@dudousxd/nestjs-diagnostics'],
      },
    },
    setupFiles: ['./vitest.setup.ts', './vitest.db.setup.ts'],
    include: ['packages/*/src/**/*.db.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
