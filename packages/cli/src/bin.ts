#!/usr/bin/env node
import type { RunStatus } from '@dudousxd/nestjs-durable-core';
import { type InspectOptions, cancelRun, inspect } from './inspect';
import { loadStore } from './load-config';

const USAGE = `durable — inspect and control nestjs-durable workflow runs

Usage:
  durable inspect                 list recent runs
  durable inspect <runId>         show a run's step timeline
  durable inspect --status failed filter the list by status
  durable cancel <runId>          soft-cancel a run (marks it cancelled in the store)

Options:
  --status <status>   running | suspended | completed | failed | cancelled
  --limit <n>         max runs to list (default 50)
  --config <path>     path to the durable config (default: ./durable.config.{mjs,js,cjs})

The config exports a configured store, e.g. \`export const store = new MikroOrmStateStore(orm)\`.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== 'inspect' && command !== 'cancel') {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const opts: InspectOptions & { config?: string | undefined } = {};
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === '--status') {
      opts.status = value as RunStatus;
      i += 1;
    } else if (arg === '--limit') {
      opts.limit = Number(value);
      i += 1;
    } else if (arg === '--config') {
      opts.config = value;
      i += 1;
    } else if (arg && !arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  const store = await loadStore(opts.config);

  if (command === 'cancel') {
    const runId = positional[0];
    if (!runId) {
      console.error('Usage: durable cancel <runId>');
      process.exit(1);
    }
    console.log(await cancelRun(store, runId));
    return;
  }

  opts.runId = positional[0];
  console.log(await inspect(store, opts));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
