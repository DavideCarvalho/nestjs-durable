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
      '@dudousxd/nestjs-durable-transport-event-emitter': pkg('transport-event-emitter'),
      '@dudousxd/nestjs-durable': pkg('nestjs'),
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
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/src/**/*.{test,spec}.ts', 'examples/*/src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.{test,spec}.ts', 'packages/*/src/index.ts'],
    },
  },
});
