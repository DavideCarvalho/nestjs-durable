export type RunStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'dead';
export type StepKind = 'local' | 'remote' | 'sleep' | 'signal';

/** This deployment's durable role — mirrors the server's `DurableTopology` (kept local so the SPA
 *  stays standalone). `tenant` is the isolation partition name, set only when `role` is 'tenant'. */
export interface DurableTopology {
  role: 'control-plane' | 'tenant';
  tenant?: string;
}

/** What an event-parked suspended run is waiting on — mirror of the server's `RunWaiting`. The control
 *  plane resolves it from the run's signal waiters so a list row can NAME the wait without the timeline. */
export interface RunWaiting {
  on: 'signal' | 'webhook' | 'child';
  name: string;
}

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
  /** The worker-pool partition (tenant) this run belongs to. `'default'` (or absent) on a single-pool
   *  / control-plane run; a named tenant on a multi-tenant deployment — shown in the UI when set. */
  namespace?: string;
  /** Set on runs from `listRuns` (control-plane-enriched): what an event-parked suspended run waits on. */
  waiting?: RunWaiting;
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
  /**
   * Shared tag across the N siblings of one `ctx.gather`/`ctx.all` fan-out (e.g. `gather:1` /
   * `all:1`). The prefix is cosmetic; every sibling of ONE fan shares the same exact string, so the
   * dashboard groups by exact string to render them as same-level siblings. Absent for non-fan steps.
   */
  parallelGroup?: string;
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
 *  parked run, but WHY it's parked reads very differently, so we refine it for display only.
 *  `no-worker` (blocked: no live worker for its handler) and `queued` (waiting behind a singleton
 *  leader) are derived by {@link deriveRunState} from worker health + the sibling run list. */
export type RunDisplayStatus = RunStatus | 'sleeping' | 'awaiting' | 'no-worker' | 'queued';

/** A run's display state for a list row: the refined {@link RunDisplayStatus} (drives colour/pulse)
 *  plus a short human `detail` naming WHY — the signal/webhook/child token, the singleton leader, or
 *  the handler with no worker. `detail` is absent for plain states (running/completed/…). */
export interface RunDisplayState {
  status: RunDisplayStatus;
  detail?: string;
}

/** Statuses that keep a singleton slot / queue behind it (mirrors the engine's `admit()` scan). */
const SINGLETON_INFLIGHT = new Set<RunStatus>(['running', 'suspended', 'cancelling']);

/** Strip the route-by-handler `@partition` suffix so a run's `workflow` matches its `GroupHealth.group`
 *  base token (queues are `<name>@<tenant>` on tenants, bare `<name>` on the control plane). */
export function baseGroup(group: string): string {
  const at = group.lastIndexOf('@');
  return at === -1 ? group : group.slice(0, at);
}

/** Whether any live worker serves `group` (matched by base token, ignoring the `@partition` suffix). */
function groupHasLiveWorker(group: string, health: readonly GroupHealth[]): boolean {
  const base = baseGroup(group);
  return health.some((h) => baseGroup(h.group) === base && h.liveWorkers.length > 0);
}

/** Whether any live worker serves `run.workflow`. A workflow with no matching health entry (or every
 *  match at zero live workers) has no worker: the run can't advance until one rejoins. */
function workflowHasLiveWorker(run: WorkflowRun, health: readonly GroupHealth[]): boolean {
  return groupHasLiveWorker(run.workflow, health);
}

/** Label a signal-checkpoint token (the raw waiter token) the way the server names `RunWaiting`, so a
 *  detail-view wait reads the same as its list row: `webhook <token>` / `child <id>` / `signal <name>`. */
function tokenDetail(token: string): string {
  if (token.startsWith('wh:')) return `webhook ${token}`;
  if (token.startsWith('child:')) return `child ${token.slice('child:'.length)}`;
  return `signal ${token}`;
}

/** The singleton leader among `runs` sharing this run's `singleton:<key>` tag: the oldest in-flight
 *  (running/suspended/cancelling) by `(createdAt, id)` — the one holding the single slot (limit 1),
 *  replicating the engine's `admit()`. `undefined` when the run isn't a singleton. */
export function singletonLeader(
  run: WorkflowRun,
  runs: readonly WorkflowRun[],
): WorkflowRun | undefined {
  const tag = run.tags?.find((t) => t.startsWith('singleton:'));
  if (!tag) return undefined;
  const inflight = runs
    .filter((r) => SINGLETON_INFLIGHT.has(r.status) && r.tags?.includes(tag))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return inflight[0];
}

/** Human label for an event wait: "signal `approve`" / "webhook `stripe-cb`" / "child `run-xyz`". */
function waitingDetail(waiting: RunWaiting): string {
  return `${waiting.on} ${waiting.name}`;
}

/**
 * Refine a run into a {@link RunDisplayState}, joining it against the sibling run list (`runs`, for
 * singleton position), live worker `health` (for no-worker), and — in the DETAIL view — its `timeline`
 * for step-level precision. Passing the same `health`/`runs` makes the list row and the detail header
 * AGREE (the list just omits `timeline`).
 *
 * Precedence for a suspended run: queued-behind-singleton → (with timeline) an in-flight step
 * running/no-worker · a genuine signal wait · a real sleep → the control-plane-named event wait
 * (list rows, no timeline) → no-worker when its workflow has no live worker → running. A live worker
 * flips it off "no worker"/"queued" on the next poll. A `pending` run with no worker also reads
 * `no-worker`; every other status passes through.
 */
export function deriveRunState(
  run: WorkflowRun,
  ctx: {
    runs: readonly WorkflowRun[];
    health: readonly GroupHealth[];
    timeline?: readonly StepCheckpoint[];
  },
): RunDisplayState {
  if (run.status !== 'suspended') {
    if (run.status === 'pending' && !workflowHasLiveWorker(run, ctx.health)) {
      return { status: 'no-worker', detail: run.workflow };
    }
    return { status: run.status };
  }

  const leader = singletonLeader(run, ctx.runs);
  if (leader && leader.id !== run.id) {
    return { status: 'queued', detail: `behind leader ${leader.id.slice(0, 8)}` };
  }

  // Detail view: the timeline says exactly what's in flight — a step, a signal wait, or a sleep.
  const pending = ctx.timeline?.find((s) => s.status === 'pending' || s.status === 'running');
  if (pending) {
    if (pending.kind === 'signal') return { status: 'awaiting', detail: tokenDetail(pending.name) };
    if (pending.kind === 'sleep') return { status: 'sleeping' };
    // A remote/local step in flight — running if a worker serves its group, else it's stuck no-worker.
    if (pending.workerGroup && !groupHasLiveWorker(pending.workerGroup, ctx.health)) {
      return { status: 'no-worker', detail: baseGroup(pending.workerGroup) };
    }
    return { status: 'running' };
  }

  // Control-plane-named event wait (list rows have no timeline to read the pending signal checkpoint).
  if (run.waiting) return { status: 'awaiting', detail: waitingDetail(run.waiting) };

  // Nothing pending: the run has settled a step and needs its WORKFLOW worker to advance the decision.
  if (!workflowHasLiveWorker(run, ctx.health)) return { status: 'no-worker', detail: run.workflow };
  return { status: 'running' };
}

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

/** How a worker decides its concurrency (mirror of core `WorkerConcurrencyStatus`). */
export interface WorkerConcurrencyStatus {
  mode: 'fixed' | 'adaptive';
  /** The concurrency ceiling in effect now (fixed: configured; adaptive: the live limit). */
  limit: number;
  /** Adaptive only — the floor the controller won't go below. */
  min?: number;
  /** Adaptive only — the ceiling the controller won't exceed. */
  max?: number;
}

/** The adaptive controller's most recent limit change (mirror of core `WorkerAdjust`). */
export interface WorkerAdjust {
  at: number;
  from: number;
  to: number;
  reason: 'ram_ceiling' | 'cpu_ceiling' | 'backpressure' | 'grow' | 'shrink';
}

/** A live snapshot of a worker's execution state riding the heartbeat (mirror of core
 *  `WorkerStatus`). Every field beyond concurrency/inFlight is best-effort and may be omitted. */
export interface WorkerStatus {
  runtime?: 'node' | 'python';
  concurrency: WorkerConcurrencyStatus;
  inFlight: number;
  rssBytes?: number;
  rssLimitBytes?: number;
  rssPct?: number;
  cpuPct?: number;
  throughputPerMin?: number;
  p95Ms?: number;
  lastAdjust?: WorkerAdjust;
}

/** One worker's liveness record (mirror of the engine's `WorkerHeartbeat`). */
export interface WorkerHeartbeat {
  group: string;
  instanceId: string;
  lastBeatAt: number;
  /** Live execution snapshot, when the heartbeat carries one (older SDKs leave it undefined). */
  status?: WorkerStatus;
}

/** Per-group worker health for the Workers panel: backlog vs. live workers. The alert state a row
 *  turns red on is `depth > 0 && liveWorkers.length === 0` (work piling up with no consumer). */
export interface GroupHealth {
  group: string;
  depth: number;
  liveWorkers: WorkerHeartbeat[];
  /** Whether this group serves a `@Workflow` or a `@Step`/handler (route-by-handler gives each its own
   *  queue). Classified by the control plane from its registry; `undefined` when it couldn't. Lets the
   *  panel summarise in domain terms ("N workflows · M steps") instead of the raw queue count. */
  kind?: 'workflow' | 'step';
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
  /** This deployment's durable role (control plane vs tenant) + tenant name — for the header badge. */
  topology(): Promise<DurableTopology> {
    return http<DurableTopology>('/topology');
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

// Re-export the canonical saga-compensation split so external consumers (e.g. flip) separate a
// run's body from its undo checkpoints the exact same way the dashboard does — by `seq < 0`.
export {
  type CompensationSummary,
  compensationDisplayName,
  compensationSummary,
  splitCompensations,
} from './split-compensations';
