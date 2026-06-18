export type RunStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'dead';
export type StepKind = 'local' | 'remote' | 'sleep' | 'signal';

export interface WorkflowRun {
  id: string;
  workflow: string;
  workflowVersion: string;
  status: RunStatus;
  input?: unknown;
  output?: unknown;
  error?: { message: string; code?: string };
  wakeAt?: number;
  recoveryAttempts?: number;
  tags?: string[];
  searchAttributes?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface StepEvent {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  /** Stable run identity for a sub-process; distinct invocations of the same `name` get distinct ids. */
  subId?: string;
  /** For a sub-step/sub-process within the step: its name. */
  name?: string;
  /** Open, consumer-defined grouping label for a sub-process (e.g. a handler/lane). */
  group?: string;
  /** For a sub-step: its terminal outcome. */
  status?: 'ok' | 'failed' | 'skipped';
  /** Open, consumer-defined intermediate phase label for a sub-process transition (no `status`). */
  phase?: string;
  /** @deprecated owning sub-process **name** for a log line — superseded by `subId`. */
  process?: string;
  data?: unknown;
}

export interface StepCheckpoint {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  /**
   * `pending` = a remote step dispatched and awaiting its worker result (in-flight).
   * `running` = a local step whose body is executing right now (in-flight).
   */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** What the step was called with (a remote step's `ctx.call` args). */
  input?: unknown;
  output?: unknown;
  error?: { message: string };
  /** Structured events the step (or its worker) emitted — sub-process outcomes + debug/error logs. */
  events?: StepEvent[];
  attempts: number;
  workerGroup?: string;
  wakeAt?: number;
  /** When the step was dispatched (remote) or began (local). Queue-wait = startedAt − enqueuedAt. */
  enqueuedAt?: string;
  /** When processing actually began: worker pickup for a remote step, execution start for a local one. */
  startedAt: string;
  finishedAt: string;
}

export interface RunDetail {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  /** Ids of runs this run spawned (ctx.child / ctx.startChild) — the parent→children tree. */
  children?: string[];
}

/** A run's status as shown to a human. The engine stores one generic `suspended` for any durably
 *  parked run, but WHY it's parked reads very differently, so we refine it for display only. */
export type RunDisplayStatus = RunStatus | 'sleeping' | 'awaiting';

/**
 * Refine a run's stored status for display. The engine keeps `suspended` for every durably-parked
 * run (it's what drives recovery/timers/queries — we never change that), but to a human a run whose
 * remote step is being executed by a worker right now is `running`, a durable sleep is `sleeping`,
 * and a wait on a signal is `awaiting`. Pass `timeline` (the detail view has it) for full precision;
 * without it (the run list) a non-timer suspend reads as `running` — open and in progress — rather
 * than the catch-all `suspended`.
 */
export function runDisplayStatus(run: WorkflowRun, timeline?: StepCheckpoint[]): RunDisplayStatus {
  if (run.status !== 'suspended') return run.status;
  // a remote step is in flight (`pending`) or a local step body is executing (`running`)
  if (timeline?.some((s) => s.status === 'pending' || s.status === 'running')) return 'running';
  if (run.wakeAt != null) return 'sleeping'; // parked on a durable timer
  if (timeline) return 'awaiting'; // timeline known, nothing pending, no timer → waiting on a signal
  return 'running'; // list view (no timeline): show open runs as in-progress, not the generic suspended
}

export interface EngineEvent {
  type:
    | 'run.started'
    | 'run.completed'
    | 'run.failed'
    | 'run.suspended'
    | 'step.started'
    | 'step.completed'
    | 'step.failed'
    | 'step.progress';
  runId: string;
  workflow?: string;
  seq?: number;
  name?: string;
  kind?: StepKind;
  durationMs?: number;
  /** The live step event carried by a `step.progress` (a running step's just-emitted log/sub-process). */
  event?: StepEvent;
  at: string;
}

/** One worker's liveness record (mirror of the engine's `WorkerHeartbeat`). */
export interface WorkerHeartbeat {
  group: string;
  instanceId: string;
  lastBeatAt: number;
}

/** Per-group worker health for the Workers panel: backlog vs. live workers. The alert state a row
 *  turns red on is `depth > 0 && liveWorkers.length === 0` (work piling up with no consumer). */
export interface GroupHealth {
  group: string;
  depth: number;
  liveWorkers: WorkerHeartbeat[];
}

declare global {
  interface Window {
    /** UI mount base (e.g. `/durable`) injected by the UI controller; falls back to `/durable`. */
    __DURABLE_BASE__?: string;
    /** JSON API base (e.g. `/api/durable`) injected by the UI controller; falls back to `<base>/api`. */
    __DURABLE_API__?: string;
  }
}

function apiBase(): string {
  if (typeof window !== 'undefined' && window.__DURABLE_API__) return window.__DURABLE_API__;
  const base = (typeof window !== 'undefined' && window.__DURABLE_BASE__) || '/durable';
  return `${base}/api`;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase() + path, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export const durableClient = {
  runs(status?: RunStatus, tag?: string, attr?: string[]): Promise<WorkflowRun[]> {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (tag) q.set('tag', tag);
    // Each `attr` is a `key:op:value` predicate; repeated params are ANDed server-side.
    for (const a of attr ?? []) q.append('attr', a);
    const qs = q.toString();
    return http<WorkflowRun[]>(qs ? `/runs?${qs}` : '/runs');
  },
  run(id: string): Promise<RunDetail> {
    return http<RunDetail>(`/runs/${encodeURIComponent(id)}`);
  },
  /** Per-group worker health (queue backlog + live worker heartbeats) for the Workers panel. */
  workers(): Promise<GroupHealth[]> {
    return http<GroupHealth[]>('/workers');
  },
  retry(id: string): Promise<WorkflowRun> {
    return http<WorkflowRun>(`/runs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  },
  /** Fix-and-replay: re-run a dead/failed run with a corrected input. Returns the new run's id. */
  retryWithInput(id: string, input: unknown): Promise<{ runId: string }> {
    return http<{ runId: string }>(`/runs/${encodeURIComponent(id)}/retry-with-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });
  },
  /** Bulk retry/cancel every run matching a filter. Returns how many matched + were acted on. */
  bulk(
    action: 'retry' | 'cancel',
    filter: {
      status?: RunStatus | undefined;
      tag?: string | undefined;
      attr?: string[] | undefined;
    },
  ): Promise<{ matched: number; applied: number }> {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.tag) q.set('tag', filter.tag);
    for (const a of filter.attr ?? []) q.append('attr', a);
    const qs = q.toString();
    return http<{ matched: number; applied: number }>(`/bulk/${action}${qs ? `?${qs}` : ''}`, {
      method: 'POST',
    });
  },
  cancel(id: string, opts?: { compensate?: boolean }): Promise<WorkflowRun> {
    const qs = opts?.compensate ? '?compensate=true' : '';
    return http<WorkflowRun>(`/runs/${encodeURIComponent(id)}/cancel${qs}`, { method: 'POST' });
  },
  continue(id: string): Promise<WorkflowRun> {
    return http<WorkflowRun>(`/runs/${encodeURIComponent(id)}/continue`, { method: 'POST' });
  },
  /**
   * Live-tail a run's lifecycle events over SSE (replaces polling). Calls `onEvent` per event;
   * returns a function to close the stream. Cross-pod when the server transport has a control plane.
   */
  streamRun(id: string, onEvent: (event: EngineEvent) => void): () => void {
    const source = new EventSource(`${apiBase()}/runs/${encodeURIComponent(id)}/stream`);
    source.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as EngineEvent);
      } catch {
        /* ignore malformed event */
      }
    };
    return () => source.close();
  },
};

// Re-export the canonical sub-process grouper so external consumers (e.g. flip's embedded
// pipeline-runs view) reconstruct sub-processes from a step's events the exact same way the
// dashboard does — by run identity (`subId`/`name`), treating `phase` events as a sub's lifecycle.
export { type SubProcess, groupSubProcesses } from './group-subprocesses';
