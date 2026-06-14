export type RunStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled' | 'dead';
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
  createdAt: string;
  updatedAt: string;
}

export interface StepEvent {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  /** For a sub-step/sub-process within the step: its name. */
  name?: string;
  /** For a sub-step: its outcome. */
  status?: 'ok' | 'failed' | 'skipped';
  data?: unknown;
}

export interface StepCheckpoint {
  runId: string;
  seq: number;
  name: string;
  kind: StepKind;
  /** `pending` = a remote step dispatched and awaiting its worker result (in-flight). */
  status: 'pending' | 'completed' | 'failed';
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
}

export interface EngineEvent {
  type:
    | 'run.started'
    | 'run.completed'
    | 'run.failed'
    | 'run.suspended'
    | 'step.started'
    | 'step.completed'
    | 'step.failed';
  runId: string;
  workflow?: string;
  seq?: number;
  name?: string;
  kind?: StepKind;
  durationMs?: number;
  at: string;
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
  runs(status?: RunStatus): Promise<WorkflowRun[]> {
    return http<WorkflowRun[]>(status ? `/runs?status=${status}` : '/runs');
  },
  run(id: string): Promise<RunDetail> {
    return http<RunDetail>(`/runs/${encodeURIComponent(id)}`);
  },
  retry(id: string): Promise<WorkflowRun> {
    return http<WorkflowRun>(`/runs/${encodeURIComponent(id)}/retry`, { method: 'POST' });
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
