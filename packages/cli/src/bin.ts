#!/usr/bin/env node
import type { RunStatus } from '@dudousxd/nestjs-durable-core';
import { type InspectOptions, inspect } from './inspect';
import { loadStore } from './load-config';

const USAGE = `durable — inspect nestjs-durable workflow runs

Usage:
  durable inspect                 list recent runs
  durable inspect <runId>         show a run's step timeline
  durable inspect --status failed filter the list by status

Options:
  --status <status>   running | suspended | completed | failed | cancelled
  --limit <n>         max runs to list (default 50)
  --config <path>     path to the durable config (default: ./durable.config.{mjs,js,cjs})

The config exports a configured store, e.g. \`export const store = new MikroOrmStateStore(orm)\`.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'inspect') {
    console.log(USAGE);
    process.exit(argv[0] ? 1 : 0);
  }

  const opts: InspectOptions & { config?: string } = {};
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
  opts.runId = positional[0];

  const store = await loadStore(opts.config);
  console.log(await inspect(store, opts));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
