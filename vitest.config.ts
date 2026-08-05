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
      '@dudousxd/nestjs-durable-dashboard': fileURLToPath(
        new URL('./packages/dashboard/src/server/index.ts', import.meta.url),
      ),
      '@dudousxd/nestjs-durable': pkg('nestjs'),
      '@dudousxd/nestjs-durable-telescope': pkg('telescope'),
      '@dudousxd/durable-worker': pkg('worker'),
    },
  },
  plugins: [
    // Emit `emitDecoratorMetadata` so NestJS DI works under Vitest (esbuild can't do it).
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', tsx: true, decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
          // Use React's automatic JSX runtime (matches the dashboard's `jsx: react-jsx`), so .tsx
          // component-render tests work without a `React` global in scope.
          react: { runtime: 'automatic' },
        },
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
    include: [
      // `.tsx` too: the dashboard's React tier (`packages/dashboard/src/react`) ships published
      // components, and a `.ts`-only glob silently collected none of their specs.
      'packages/*/src/**/*.{test,spec}.{ts,tsx}',
      'examples/*/src/**/*.{test,spec}.{ts,tsx}',
    ],
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
