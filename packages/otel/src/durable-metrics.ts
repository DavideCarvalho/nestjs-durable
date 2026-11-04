import type { WorkflowEngine } from '@dudousxd/nestjs-durable-core';

/** An event another instance produced and the control plane re-delivered here (see the core's
 *  `isRemoteEvent`); read by symbol so an older core, which marks none, still works. */
const REMOTE_EVENT = Symbol.for('@dudousxd/nestjs-durable:remote-event');
const isRemote = (event: object): boolean =>
  (event as { [REMOTE_EVENT]?: unknown })[REMOTE_EVENT] === true;

export interface DurationStats {
  count: number;
  /** Median, 95th percentile, and max — in milliseconds. */
  p50: number;
  p95: number;
  max: number;
}

export interface DurableMetricsSnapshot {
  runs: {
    started: number;
    completed: number;
    failed: number;
    suspended: number;
    /** Failures handed to an onError handler instead of failing the run. */
    routed: number;
    /** Failures that had onError routes the engine could not apply (workers disagree). */
    unrouted: number;
    /** Subscriber runs started by a settled run's lifecycle event. */
    triggered: number;
    /** Subscribers a settled run's lifecycle event could not start (`where` threw, start failed). */
    triggerFailed: number;
  };
  /** Routed failures by error code (`*` for a failure without one). */
  routedByCode: Record<string, number>;
  /**
   * The `durable.runs.triggered` counter by its attributes: `workflow` (the settled run's) and
   * `subscriber` (the workflow its lifecycle event started), keyed by workflow, then subscriber.
   */
  triggeredBySubscriber: Record<string, Record<string, number>>;
  steps: { completed: number; failed: number };
  /** Per-step wall-clock (from the `durationMs` on step events). */
  stepDurationMs: DurationStats;
  /** Per-run wall-clock, measured `run.started` → terminal. */
  runDurationMs: DurationStats;
}

export interface DurableMetrics {
  /** A point-in-time copy of the counters and duration percentiles. */
  snapshot(): DurableMetricsSnapshot;
  /** Zero everything (e.g. between scrape windows). */
  reset(): void;
  /** Stop collecting. */
  unsubscribe(): void;
}

function stats(xs: number[]): DurationStats {
  if (xs.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return { count: sorted.length, p50: at(50), p95: at(95), max: sorted[sorted.length - 1] ?? 0 };
}

/**
 * Collect lightweight, dependency-free metrics from engine lifecycle events: run/step counts by
 * outcome and run/step duration percentiles. Pull `snapshot()` from a `/metrics` route, a Telescope
 * pulse, or a scheduled exporter. Returns a handle with `snapshot()`, `reset()` and `unsubscribe()`.
 */
export function attachDurableMetrics(engine: WorkflowEngine): DurableMetrics {
  const zeroRuns = () => ({
    started: 0,
    completed: 0,
    failed: 0,
    suspended: 0,
    routed: 0,
    unrouted: 0,
    triggered: 0,
    triggerFailed: 0,
  });
  let runs = zeroRuns();
  let routedByCode: Record<string, number> = {};
  let triggeredBy: Record<string, Record<string, number>> = {};
  let steps = { completed: 0, failed: 0 };
  let stepDur: number[] = [];
  let runDur: number[] = [];
  const runStart = new Map<string, number>();

  const finishRun = (runId: string, at: Date) => {
    const t0 = runStart.get(runId);
    if (t0 != null) {
      runDur.push(at.getTime() - t0);
      runStart.delete(runId);
    }
  };

  const unsubscribe = engine.subscribe((e) => {
    if (isRemote(e)) return;
    switch (e.type) {
      case 'run.started':
        runs.started += 1;
        runStart.set(e.runId, e.at.getTime());
        break;
      case 'run.completed':
        runs.completed += 1;
        finishRun(e.runId, e.at);
        break;
      case 'run.failed':
        runs.failed += 1;
        finishRun(e.runId, e.at);
        break;
      case 'run.suspended':
        runs.suspended += 1;
        break;
      case 'run.routed': {
        runs.routed += 1;
        const code = e.error?.code ?? '*';
        routedByCode[code] = (routedByCode[code] ?? 0) + 1;
        break;
      }
      case 'run.unrouted':
        runs.unrouted += 1;
        break;
      case 'run.triggered': {
        runs.triggered += 1;
        const workflow = e.workflow ?? 'unknown';
        const subscriber = e.name ?? 'unknown';
        const bySubscriber = triggeredBy[workflow] ?? {};
        bySubscriber[subscriber] = (bySubscriber[subscriber] ?? 0) + 1;
        triggeredBy[workflow] = bySubscriber;
        break;
      }
      case 'run.trigger_failed':
        runs.triggerFailed += 1;
        break;
      case 'step.completed':
        steps.completed += 1;
        if (e.durationMs != null) stepDur.push(e.durationMs);
        break;
      case 'step.failed':
        steps.failed += 1;
        if (e.durationMs != null) stepDur.push(e.durationMs);
        break;
    }
  });

  return {
    snapshot: () => ({
      runs: { ...runs },
      routedByCode: { ...routedByCode },
      triggeredBySubscriber: structuredClone(triggeredBy),
      steps: { ...steps },
      stepDurationMs: stats(stepDur),
      runDurationMs: stats(runDur),
    }),
    reset: () => {
      runs = zeroRuns();
      routedByCode = {};
      triggeredBy = {};
      steps = { completed: 0, failed: 0 };
      stepDur = [];
      runDur = [];
      runStart.clear();
    },
    unsubscribe,
  };
}
