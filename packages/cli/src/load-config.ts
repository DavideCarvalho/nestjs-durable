import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StateStore } from '@dudousxd/nestjs-durable-core';
import type { LifecycleRepublisher } from './lifecycle';

const CONFIG_NAMES = ['durable.config.mjs', 'durable.config.js', 'durable.config.cjs'];

// A native dynamic import that TypeScript won't down-level to `require` in CommonJS output, so a
// CJS bin can still load an ESM (.mjs) config.
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

/**
 * Load the `StateStore` the CLI inspects from a `durable.config.{mjs,js,cjs}` at the cwd (or an
 * explicit path). The config exports a `store` — your already-configured adapter, e.g.
 * `export const store = new MikroOrmStateStore(orm)`.
 */
export async function loadStore(explicitPath?: string): Promise<StateStore> {
  const { file, mod } = await loadConfig(explicitPath);
  const asDefault = mod.default as { store?: unknown } | undefined;
  const store: unknown = mod.store ?? asDefault?.store ?? asDefault;
  if (!isStateStore(store)) {
    throw new Error(`${file} must export a \`store\` (a StateStore).`);
  }
  return store;
}

/**
 * Load the engine `durable lifecycle:republish` publishes through, from the same config: an
 * exported `engine`, a `WorkflowEngine` with the subscribing workflows registered (their `where`
 * and `input` run in this process).
 */
export async function loadEngine(explicitPath?: string): Promise<LifecycleRepublisher> {
  const { file, mod } = await loadConfig(explicitPath);
  const asDefault = mod.default as { engine?: unknown } | undefined;
  const engine: unknown = mod.engine ?? asDefault?.engine;
  if (
    typeof engine !== 'object' ||
    engine === null ||
    typeof (engine as LifecycleRepublisher).republishLifecycle !== 'function'
  ) {
    throw new Error(
      `${file} must export an \`engine\` (a WorkflowEngine with the subscribers registered).`,
    );
  }
  return engine as LifecycleRepublisher;
}

async function loadConfig(
  explicitPath?: string,
): Promise<{ file: string; mod: Record<string, unknown> }> {
  const file = explicitPath
    ? resolve(explicitPath)
    : CONFIG_NAMES.map((name) => resolve(process.cwd(), name)).find(existsSync);
  if (!file || !existsSync(file)) {
    throw new Error(
      'No durable config found. Create a durable.config.js that exports `{ store }`.',
    );
  }
  return { file, mod: await nativeImport(pathToFileURL(file).href) };
}

function isStateStore(value: unknown): value is StateStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StateStore).listRuns === 'function'
  );
}
