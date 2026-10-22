#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import type { RunStatus } from '@dudousxd/nestjs-durable-core';
import {
  DEFAULT_STALE_MS,
  type InspectOptions,
  cancelRun,
  exportRun,
  inspect,
  parseDurationMs,
} from './inspect';
import { loadStore } from './load-config';

const USAGE = `durable — inspect and control nestjs-durable workflow runs

Usage:
  durable inspect                 list recent runs
  durable inspect <runId>         show a run's step timeline
  durable inspect --status failed filter the list by status
  durable inspect --stale[=1h]    only runs that look stranded (default threshold 15m)
  durable cancel <runId>          soft-cancel a run (marks it cancelled in the store)
  durable export <runId>          print a run's replay fixture (JSON) for assertReplayable

Options:
  --status <status>   running | suspended | completed | failed | cancelled
  --limit <n>         max runs to list (default 50)
  --stale[=<dur>]     stranded runs idle at least <dur> (90s, 15m, 4h, 2d; default 15m)
  --namespace <ns>    restrict the listing to one namespace
  --out <file>        (export) write the fixture to a file instead of stdout
  --config <path>     path to the durable config (default: ./durable.config.{mjs,js,cjs})

The config exports a configured store, e.g. \`export const store = new MikroOrmStateStore(orm)\`.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command !== 'inspect' && command !== 'cancel' && command !== 'export') {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }

  const opts: InspectOptions & { config?: string | undefined; out?: string | undefined } = {};
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
    } else if (arg === '--stale' || arg?.startsWith('--stale=')) {
      const raw = arg.slice('--stale='.length);
      const parsed = arg === '--stale' ? DEFAULT_STALE_MS : parseDurationMs(raw);
      if (parsed === undefined) {
        console.error(`Invalid --stale duration "${raw}" (use e.g. 90s, 15m, 4h, 2d).`);
        process.exit(1);
      }
      opts.staleMs = parsed;
    } else if (arg === '--namespace') {
      opts.namespace = value;
      i += 1;
    } else if (arg === '--out') {
      opts.out = value;
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

  if (command === 'export') {
    const runId = positional[0];
    if (!runId) {
      console.error('Usage: durable export <runId> [--out fixture.json]');
      process.exit(1);
    }
    const json = await exportRun(store, runId);
    if (json === null) {
      console.error(`Run ${runId} not found.`);
      process.exit(1);
    }
    if (opts.out) {
      await writeFile(opts.out, json, 'utf8');
      console.error(`Exported run ${runId} to ${opts.out}.`);
    } else {
      process.stdout.write(json);
    }
    return;
  }

  opts.runId = positional[0];
  console.log(await inspect(store, opts));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
