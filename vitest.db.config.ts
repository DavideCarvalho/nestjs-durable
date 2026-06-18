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
      '@dudousxd/nestjs-durable-core': pkg('core'),
      '@dudousxd/nestjs-durable-testing': pkg('testing'),
      '@dudousxd/nestjs-durable-transport-event-emitter': pkg('transport-event-emitter'),
      '@dudousxd/nestjs-durable': pkg('nestjs'),
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
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/src/**/*.db.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
