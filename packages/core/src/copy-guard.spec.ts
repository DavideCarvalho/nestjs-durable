import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_COPY_DOCS,
  DuplicateDurableCopyError,
  type DurableCopyRegistry,
  assertSingleDurableCopy,
  durableCopies,
  durableCopyRegistry,
  registerDurableCopy,
  sealDurableCopies,
} from './copy-guard';
// Importing the engine is what registers this copy in a real app.
import './engine';

function freshRegistry(): DurableCopyRegistry {
  return { copies: new Map(), booted: false };
}

const A = {
  version: '0.93.0',
  root: '/app/node_modules/.pnpm/@dudousxd+nestjs-durable-core@0.93.0_a/node_modules/@dudousxd/nestjs-durable-core',
};
const B = {
  version: '0.93.0',
  root: '/app/node_modules/.pnpm/@dudousxd+nestjs-durable-core@0.93.0_b/node_modules/@dudousxd/nestjs-durable-core',
};

describe('durable copy guard', () => {
  it('registers this package once, keyed by its real package root', () => {
    const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
    const { version } = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
      version: string;
    };
    const mine = durableCopies(durableCopyRegistry()).filter((c) => c.root === root);
    expect(mine).toEqual([{ version, root }]);
    expect(() => assertSingleDurableCopy()).not.toThrow();
  });

  it('tolerates the same copy registering twice', () => {
    const registry = freshRegistry();
    registerDurableCopy(A, registry);
    registerDurableCopy({ ...A }, registry);
    sealDurableCopies(registry);
    registerDurableCopy({ ...A }, registry);
    expect(durableCopies(registry)).toHaveLength(1);
  });

  it('throws at boot when two distinct copies registered, naming both, the fix and the docs', () => {
    const registry = freshRegistry();
    registerDurableCopy(A, registry);
    registerDurableCopy(B, registry);
    let error: unknown;
    try {
      sealDurableCopies(registry);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DuplicateDurableCopyError);
    const message = (error as Error).message;
    expect(message).toContain(A.root);
    expect(message).toContain(B.root);
    expect(message).toContain('declare the same peer dependency versions');
    expect(message).toContain('pnpm overrides');
    expect(message).toContain(DUPLICATE_COPY_DOCS);
    expect((error as DuplicateDurableCopyError).copies).toEqual([A, B]);
    expect(registry.booted).toBe(false);
  });

  it('throws when a distinct copy loads after boot', () => {
    const registry = freshRegistry();
    registerDurableCopy(A, registry);
    sealDurableCopies(registry);
    expect(() => registerDurableCopy(B, registry)).toThrow(DuplicateDurableCopyError);
  });

  it('shares one registry through globalThis', () => {
    expect(durableCopyRegistry()).toBe(
      (globalThis as Record<symbol, unknown>)[Symbol.for('@dudousxd/nestjs-durable.copies')],
    );
  });
});
