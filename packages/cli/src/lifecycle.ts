import type {
  RepublishLifecycleResult,
  RepublishLifecycleTarget,
} from '@dudousxd/nestjs-durable-core';

/** The part of a `WorkflowEngine` `durable lifecycle:republish` drives. */
export interface LifecycleRepublisher {
  republishLifecycle(target: RepublishLifecycleTarget): Promise<RepublishLifecycleResult>;
}

/** The `lifecycle:republish` flags, as parsed from the command line. */
export interface RepublishOptions {
  run?: string | undefined;
  workflow?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  subscriber?: string | undefined;
  limit?: number | undefined;
}

function parseDate(flag: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${flag} date "${value}".`);
  return date;
}

/**
 * The engine target the flags describe: `--run <id>` for one run, or `--workflow <name>` with
 * optional `--since` / `--until` (ISO dates) for its settled runs. `--subscriber` narrows either.
 */
export function republishTarget(opts: RepublishOptions): RepublishLifecycleTarget {
  const subscriber = opts.subscriber !== undefined ? { subscriber: opts.subscriber } : {};
  if (opts.run !== undefined && opts.workflow !== undefined) {
    throw new Error('Pass --run or --workflow, not both.');
  }
  if (opts.run !== undefined) return { runId: opts.run, ...subscriber };
  if (opts.workflow === undefined) throw new Error('Pass --run <runId> or --workflow <name>.');
  return {
    workflow: opts.workflow,
    ...(opts.since !== undefined ? { since: parseDate('--since', opts.since) } : {}),
    ...(opts.until !== undefined ? { until: parseDate('--until', opts.until) } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...subscriber,
  };
}

/** Republish and render what happened as plain text. */
export async function republishLifecycle(
  engine: LifecycleRepublisher,
  opts: RepublishOptions,
): Promise<string> {
  const result = await engine.republishLifecycle(republishTarget(opts));
  const lines = [
    `Republished ${result.runs} run${result.runs === 1 ? '' : 's'}: started ${result.started} subscriber run${result.started === 1 ? '' : 's'}, ${result.failed.length} failed.`,
  ];
  for (const failure of result.failed) {
    lines.push(`  ${failure.runId} → ${failure.subscriber}: ${failure.error}`);
  }
  return lines.join('\n');
}
