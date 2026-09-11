import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Every peer this package declares `optional` has to be absent-safe for real: a consumer that takes
 * `peerDependenciesMeta` at its word installs without it, so any static `import` the bundle emits
 * kills the whole entry point with `ERR_MODULE_NOT_FOUND` before a line of consumer code runs.
 *
 * `pnpm test` runs against `src/` (vitest.config.ts aliases every workspace package to its source),
 * where a type-only import, a lazy `import()` and a hard dependency are indistinguishable. Only the
 * EMITTED bundle settles it — SWC's `design:paramtypes` metadata, for one, turns a constructor
 * param's declared type back into a value reference. So this suite probes the built artifact.
 *
 * `dist/` is COPIED into the temp root rather than symlinked: Node resolves a symlinked module to
 * its realpath before resolving that module's own imports, so a symlinked `dist/` would find the
 * hidden peer back in the workspace and the probe would prove nothing. `NODE_PATH` is cleared for
 * the same reason — pnpm's bin shim points it at the virtual store, which holds every package in
 * the monorepo, and CJS `require` (unlike ESM) honours it.
 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

const optionalPeers = Object.entries(pkg.peerDependenciesMeta)
  .filter(([, meta]) => meta.optional)
  .map(([name]) => name);

const tempRoots: string[] = [];

/** tsup's CLI entry, read off its own manifest so no internal `dist/` path is hard-coded here. */
function tsupBin(): string {
  const manifestPath = createRequire(join(packageRoot, 'package.json')).resolve(
    'tsup/package.json',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: { tsup: string } };
  return join(dirname(manifestPath), manifest.bin.tsup);
}

/** Mirror this package's installed `node_modules` into `dest` as symlinks, minus `hidden`. */
function linkDeps(dest: string, hidden: string[]): void {
  const source = join(packageRoot, 'node_modules');
  for (const entry of readdirSync(source)) {
    if (entry === '.bin') continue;
    if (entry.startsWith('@')) {
      mkdirSync(join(dest, entry), { recursive: true });
      for (const scoped of readdirSync(join(source, entry))) {
        const name = `${entry}/${scoped}`;
        if (!hidden.includes(name)) symlinkSync(join(source, name), join(dest, name), 'dir');
      }
      continue;
    }
    if (!hidden.includes(entry)) symlinkSync(join(source, entry), join(dest, entry), 'dir');
  }
}

/**
 * Run `script` against a throwaway install of the built package that has every dependency EXCEPT
 * `hidden`. Returns the probe's stdout; on a non-zero exit it throws carrying the child's own
 * output, so a failure names the module that could not be found.
 */
function runWithout(hidden: string[], script: string, ext: 'mjs' | 'cjs'): string {
  const root = mkdtempSync(join(tmpdir(), 'nestjs-durable-peer-'));
  tempRoots.push(root);
  const installed = join(root, 'node_modules', pkg.name);
  mkdirSync(installed, { recursive: true });
  cpSync(join(packageRoot, 'dist'), join(installed, 'dist'), { recursive: true });
  cpSync(join(packageRoot, 'package.json'), join(installed, 'package.json'));
  linkDeps(join(root, 'node_modules'), hidden);
  const probe = join(root, `probe.${ext}`);
  writeFileSync(probe, script);
  try {
    return execFileSync(process.execPath, [probe], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: '' },
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(`probe failed:\n${failure.stdout ?? ''}${failure.stderr ?? ''}`);
  }
}

/** Boot the operator role (`store` + `transport`, no `connection`) — the role that runs no worker. */
const bootOperator = `
import 'reflect-metadata';
import { InMemoryStateStore, InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { DurableModule } from '${pkg.name}';

const mod = await Test.createTestingModule({
  imports: [
    DurableModule.forRoot({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
      timerPollMs: 0,
    }),
  ],
}).compile();
await mod.init();
await mod.close();
console.log('booted');
`;

/** Boot the pure thin-worker role (`connection`, no `store`) — the role that DOES run a worker. */
const bootThinWorker = `
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DurableModule } from '${pkg.name}';

try {
  const mod = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ connection: 'redis://unused' })],
  }).compile();
  await mod.init();
  await mod.close();
  console.log('booted');
} catch (error) {
  console.log('refused:', error.message);
}
`;

/**
 * Start a workflow whose `@Workflow({ inputSchema })` DTO needs `class-validator` +
 * `class-transformer`. Decorators are applied by hand because the probe is plain JS.
 */
const validateInput = (imports: string) => `
${imports}

class OrderInput {}
IsString()(OrderInput.prototype, 'orderId');

class OrderWorkflow {
  async run() {
    return 'ok';
  }
}
Injectable()(OrderWorkflow);
Workflow({ name: 'order', version: '1', inputSchema: OrderInput })(OrderWorkflow);

const mod = await Test.createTestingModule({
  imports: [
    DurableModule.forRoot({
      store: new InMemoryStateStore(),
      transport: new InMemoryTransport(),
      timerPollMs: 0,
    }),
  ],
  providers: [OrderWorkflow],
}).compile();
await mod.init();
const service = mod.get(WorkflowService);
try {
  await service.start('order', { orderId: 7 }, 'run-1');
  console.log('accepted');
} catch (error) {
  console.log('rejected:', error.message);
}
await mod.close();
`;

const validateInputEsm = validateInput(`
import 'reflect-metadata';
import { InMemoryStateStore, InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import { DurableModule, Workflow, WorkflowService } from '${pkg.name}';
`);

const validateInputCjs = `(async () => {${validateInput(`
require('reflect-metadata');
const { InMemoryStateStore, InMemoryTransport } = require('@dudousxd/nestjs-durable-core');
const { Injectable } = require('@nestjs/common');
const { Test } = require('@nestjs/testing');
const { IsString } = require('class-validator');
const { DurableModule, Workflow, WorkflowService } = require('${pkg.name}');
`)}})();`;

/** The same start, but the probe itself never touches `class-validator` — only the package does. */
const validateInputWithoutPeer = validateInput(`
import 'reflect-metadata';
import { InMemoryStateStore, InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DurableModule, Workflow, WorkflowService } from '${pkg.name}';
const IsString = () => () => {};
`);

describe('optional peers are absent-safe in the built package', () => {
  beforeAll(() => {
    // Build the artifact under test rather than skipping when `dist/` is absent: `pnpm test` never
    // builds, and a stale `dist/` would have this suite reporting on code that no longer exists —
    // the one failure mode a bundle probe cannot afford.
    execFileSync(process.execPath, [tsupBin()], { cwd: packageRoot, stdio: 'ignore' });
  }, 180_000);

  afterAll(() => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  });

  it('covers every peer package.json marks optional', () => {
    expect(optionalPeers).toEqual([
      '@dudousxd/durable-worker',
      '@dudousxd/nestjs-context',
      'class-transformer',
      'class-validator',
      'zod',
    ]);
  });

  it.each(optionalPeers)('loads the ESM entry without %s', (peer) => {
    const out = runWithout([peer], `await import('${pkg.name}');\nconsole.log('loaded');`, 'mjs');
    expect(out).toContain('loaded');
  });

  it.each(optionalPeers)('loads the CJS entry without %s', (peer) => {
    const out = runWithout([peer], `require('${pkg.name}');\nconsole.log('loaded');`, 'cjs');
    expect(out).toContain('loaded');
  });

  it('boots an operator app with every optional peer absent', () => {
    expect(runWithout(optionalPeers, bootOperator, 'mjs')).toContain('booted');
  });

  it('names the missing peer when a role that needs the worker SDK is configured without it', () => {
    expect(runWithout(['@dudousxd/durable-worker'], bootThinWorker, 'mjs')).toContain(
      'refused: @dudousxd/durable-worker is not installed.',
    );
  });
});

/**
 * The other half of "optional": a peer reached lazily has to still be REACHABLE when it is
 * installed. A `require()` in the ESM bundle satisfies the absence probes above while being dead on
 * arrival for every ESM consumer, so each lazily-loaded peer needs a probe that uses it for real.
 */
describe('lazily loaded optional peers work when they are installed', () => {
  it('validates @Workflow({ inputSchema }) from the ESM entry', () => {
    expect(runWithout([], validateInputEsm, 'mjs')).toContain(
      'rejected: invalid input for workflow: orderId must be a string',
    );
  });

  it('validates @Workflow({ inputSchema }) from the CJS entry', () => {
    expect(runWithout([], validateInputCjs, 'cjs')).toContain(
      'rejected: invalid input for workflow: orderId must be a string',
    );
  });

  it('names the missing peers when inputSchema is used without class-validator', () => {
    expect(runWithout(['class-validator'], validateInputWithoutPeer, 'mjs')).toContain(
      'rejected: @Workflow({ inputSchema }) needs the optional peers',
    );
  });
});
