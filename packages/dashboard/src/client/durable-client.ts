import type {
  RunListItem as CoreRunListItem,
  RunStatus as CoreRunStatus,
  RunWaiting as CoreRunWaiting,
  StepCheckpoint as CoreStepCheckpoint,
  StepEvent as CoreStepEvent,
  StepKind as CoreStepKind,
  StepError,
  WireDates,
} from '@dudousxd/nestjs-durable-core';

// Type-only imports erase at build time (this is a standalone SPA bundle, never imports core's
// runtime) — the dashboard package already depends on core server-side, so its client tsconfig
// resolves these the same way. Wire types below are DERIVED from core via `WireDates` instead of
// hand-mirrored field by field, so a new core field shows up here automatically instead of silently
// drifting; each deliberate divergence from core is called out and justified inline where it's made.

// Headless console-launcher primitives (path derivation + mint-then-navigate). Re-exported here
// because `./client` resolves to this file — see the package's `exports` map.
export {
  ConsoleSessionError,
  durableConsoleSessionUrl,
  durableConsoleUrl,
  mintDurableConsoleSession,
  openDurableConsole,
  type OpenConsoleOptions,
} from './console-session.js';

export type RunStatus = CoreRunStatus;
export type StepKind = CoreStepKind;

/** This deployment's durable role — mirrors the server's `DurableTopology` (kept local so the SPA
 *  stays standalone). `tenant` is the isolation partition name, set only when `role` is 'tenant'. */
export interface DurableTopology {
  role: 'control-plane' | 'tenant';
  tenant?: string;
}

/** What an event-parked suspended run is waiting on. Derived from core: adding a new `on` variant
 *  there (e.g. `breakpoint`) shows up here with no client-side edit needed. */
export type RunWaiting = CoreRunWaiting;

/** No `Date` fields and already an exact structural match to core's `StepEvent` — derived directly. */
export type StepEvent = CoreStepEvent;

export type StepCheckpoint = Omit<
  WireDates<CoreStepCheckpoint>,
  'stepId' | 'enqueuedAt' | 'error'
> & {
  /**
   * Kept OPTIONAL here (core's `enqueuedAt` is a required `Date`, always populated) — the two SPA
   * reads of this field (`SpansTimeline.tsx`, `StepDetailPanel.tsx`) both treat an absent value as
   * "nothing to show" for a local step's queue-wait, which is the display semantic that matters here,
   * not core's storage guarantee. Deliberate, load-bearing local divergence.
   */
  enqueuedAt?: string;
  /** Widened from the old ad-hoc `{ message; code? }` to the real `StepError` shape (adds `retryable`/
   *  `stack`) — every existing read (`step.error.message`) still works; this just stops re-declaring a
   *  narrower shadow of the server's actual error type. */
  error?: StepError;
};

export type WorkflowRun = Omit<WireDates<CoreRunListItem>, 'input' | 'error'> & {
  /**
   * Kept OPTIONAL here (core's `input` is a required `unknown`) — several SPA fixtures build a
   * `WorkflowRun` without ever setting it, and `unknown` can't be enforced-present in any way that
   * matters to a reader; the SPA never round-trips this value back to the server. Deliberate, load-
   * bearing local divergence (dropping it would force `input: undefined` onto every construction site).
   */
  input?: unknown;
  /** See {@link StepCheckpoint.error} — same widen-not-narrow convergence. */
  error?: StepError;
};

export interface RunDetail {
  run: WorkflowRun;
  timeline: StepCheckpoint[];
  /**
   * Kept OPTIONAL here (core's `children` is a required, always-populated array) — the SPA's own
   * preview/test fixtures (`preview.tsx`, `merge-live-events.spec.ts`) construct a `RunDetail` without
   * it, and every read already guards with `?.`. Deliberate, load-bearing local divergence.
   */
  children?: string[];
}

/** How long a remote step may sit `pending` (dispatched, no result) before it's presumed a LOST
 *  dispatch — the worker crashed or the transport dropped the job. Reconcile-wake can't recover this
 *  (it re-suspends a pending step), so it needs an explicit re-dispatch. */
export const STALE_PENDING_MS = 10 * 60 * 1000; // 10 min

/** A remote step checkpoint that's been `pending` (dispatched, awaiting a worker result) longer than
 *  STALE_PENDING_MS — likely a lost dispatch that will hang the run until re-dispatched. `nowMs` is
 *  injectable for tests. Returns false for non-remote / non-pending / fresh checkpoints. */
export function isStalePending(cp: StepCheckpoint, nowMs: number): boolean {
  if (cp.kind !== 'remote' || cp.status !== 'pending') return false;
  const dispatchedAt = cp.enqueuedAt
    ? new Date(cp.enqueuedAt).getTime()
    : new Date(cp.startedAt).getTime();
  return nowMs - dispatchedAt > STALE_PENDING_MS;
}

/** A run's status as shown to a human. The engine stores one generic `suspended` for any durably
 *  parked run, but WHY it's parked reads very differently, so we refine it for display only.
 *  `no-worker` (blocked: its queue has a backlog with no live consumer) and `queued` (waiting behind
 *  a singleton leader) are derived by {@link deriveRunState} from worker health + the sibling run list. */
export type RunDisplayStatus = RunStatus | 'sleeping' | 'awaiting' | 'no-worker' | 'queued';

/** A run's display state for a list row: the refined {@link RunDisplayStatus} (drives colour/pulse)
 *  plus a short human `detail` naming WHY — the signal/webhook/child token, the singleton leader, or
 *  the handler with no worker. `detail` is absent for plain states (running/completed/…). */
export interface RunDisplayState {
  status: RunDisplayStatus;
  detail?: string;
}

/** Statuses that keep a singleton slot / queue behind it (mirrors the engine's `admit()` scan). Also
 *  the query the console sends to fetch a suspended run's in-flight SIBLINGS, so the set it is placed
 *  against is the same one the engine admits against. */
export const SINGLETON_INFLIGHT_STATUSES: RunStatus[] = ['running', 'suspended', 'cancelling'];
const SINGLETON_INFLIGHT = new Set<RunStatus>(SINGLETON_INFLIGHT_STATUSES);

/** Strip the route-by-handler `@partition` suffix so a run's `workflow` matches its `GroupHealth.group`
 *  base token (queues are `<name>@<tenant>` on tenants, bare `<name>` on the control plane). */
export function baseGroup(group: string): string {
  const at = group.lastIndexOf('@');
  return at === -1 ? group : group.slice(0, at);
}

/** Whether `group` is STALLED — the library's own alert condition (`GroupHealth`, `interfaces.ts`):
 *  it has queued work (`depth > 0`) and ZERO live workers anywhere to consume it. Bare
 *  `liveWorkers === 0` is NOT a reliable "no worker" signal — a worker only heartbeats for a group
 *  while it's serving it, so an IDLE group (a suspended run parked on its reconcile timer with nothing
 *  enqueued, a scheduled workflow between its cron runs) legitimately reports zero live workers, and
 *  flagging that "no worker" is a false positive. Real backlog with no consumer is the honest signal:
 *  `workerHealth()` reports a registered group with backlog and zero workers precisely so this case is
 *  visible. Matched by base token, ignoring the `@partition` suffix (queues aggregate across tenants). */
function groupIsStalled(group: string, health: readonly GroupHealth[]): boolean {
  const base = baseGroup(group);
  const entries = health.filter((h) => baseGroup(h.group) === base);
  const anyBacklog = entries.some((h) => h.depth > 0);
  const anyWorker = entries.some((h) => h.liveWorkers.length > 0);
  return anyBacklog && !anyWorker;
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
 * (list rows, no timeline) → no-worker when its workflow queue is STALLED → running. "No worker" is
 * gated on a real backlog with no consumer (`groupIsStalled`), NOT bare `liveWorkers === 0` — an idle
 * group has no live heartbeat yet is not blocked, so bare-zero would falsely flag parked/settled runs.
 * A live worker (or an empty backlog) flips it off "no worker"/"queued" on the next poll. A `pending`
 * run whose queue is stalled also reads `no-worker`; every other status passes through.
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
    if (run.status === 'pending' && groupIsStalled(run.workflow, ctx.health)) {
      return { status: 'no-worker', detail: run.workflow };
    }
    // The engine parked this run `blocked`: no live worker can serve its next dispatch (a capability /
    // protocol gap). That is the same "act on this, nobody can run it" signal as a stalled queue, so it
    // shares the `no-worker` display (colour + attention banner). The persisted `run.error` carries no
    // routing token, so the detail names the workflow.
    if (run.status === 'blocked') {
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
    // A remote/local step in flight — its job is enqueued, so if that queue is stalled (backlog, no
    // consumer) the step is genuinely blocked; otherwise a worker is (or will be) serving it: running.
    if (pending.workerGroup && groupIsStalled(pending.workerGroup, ctx.health)) {
      return { status: 'no-worker', detail: baseGroup(pending.workerGroup) };
    }
    return { status: 'running' };
  }

  // Control-plane-named event wait (list rows have no timeline to read the pending signal checkpoint).
  if (run.waiting) return { status: 'awaiting', detail: waitingDetail(run.waiting) };

  // Nothing pending: the run has settled its last step and is parked waiting to be replayed/advanced
  // by its WORKFLOW worker. Only call that "no worker" when the workflow queue is genuinely stalled —
  // a backlog with no consumer. A parked run with nothing enqueued (the common case, incl. the runs
  // the reconcile fallback keeps retrying) has no backlog, so it reads as running (open, in flight),
  // NOT a false "no worker". It flips to no-worker the moment its resume enqueues with no consumer.
  if (groupIsStalled(run.workflow, ctx.health))
    return { status: 'no-worker', detail: run.workflow };
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

/** The SPA's own UI mount (e.g. `/durable`), independent of the (possibly host-overridden) API
 *  base — this is where `DurableUiSessionGuard` lives, so it's the right target to navigate the
 *  browser to when a session is gone and the destination isn't a known login page. */
function uiBase(): string {
  return (typeof window !== 'undefined' && window.__DURABLE_BASE__) || '/durable';
}

function apiBase(): string {
  if (typeof window !== 'undefined' && window.__DURABLE_API__) return window.__DURABLE_API__;
  return `${uiBase()}/api`;
}

/**
 * Best-effort read of the `{ auth: { modes } }` a `DurableApiSessionGuard` 401 carries (mirrors
 * `@dudousxd/nestjs-telescope`'s dashboardAuth 401 body) — the same signal `DurableUiSessionGuard`
 * would act on for a full-page navigation, just not directly reachable from an XHR. Returns
 * `undefined` for anything that doesn't parse (including an older server that predates this body,
 * or a host without `dashboardAuth` configured at all), so the caller can fall back safely.
 */
async function readAuthModes(res: Response): Promise<string[] | undefined> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || !('auth' in body)) return undefined;
    const auth = (body as { auth?: unknown }).auth;
    if (typeof auth !== 'object' || auth === null || !('modes' in auth)) return undefined;
    const modes = (auth as { modes?: unknown }).modes;
    return Array.isArray(modes)
      ? modes.filter((m): m is string => typeof m === 'string')
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A 401 mid-session (routine since `revalidate`: a deactivated/demoted operator's cookie is
 * cleared on their next renewal) means there's nothing left to render — take the browser to the
 * matching auth surface instead of leaving a raw error in the console. Mode B (`login` offered):
 * the built-in login page, carrying `returnTo` back to here. Otherwise (Mode A, or an older server
 * that sends a bare 401 with no `modes`): a plain navigation to the UI mount, which
 * `DurableUiSessionGuard` itself renders as the Mode-A session-required page — so this never has
 * to duplicate that guard's mode logic, only trigger it.
 */
function redirectToAuthSurface(modes: readonly string[] | undefined): void {
  if (typeof window === 'undefined') return;
  const base = uiBase();
  if (modes?.includes('login')) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `${base}/login?returnTo=${returnTo}`;
    return;
  }
  window.location.href = base;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase() + path, init);
  if (res.status === 401) {
    redirectToAuthSurface(await readAuthModes(res));
    // The navigation above is async; reject so the caller's `.then`/`await` chain doesn't
    // continue as if this call had succeeded while the browser is on its way elsewhere.
    throw new Error('Session expired; redirecting to sign-in.');
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * The later-added run facets, kept in one options bag rather than growing `runs()`'s positional tail
 * to five arguments. Both are OMITTED by default, and that default is load-bearing: the console has
 * always listed every tenant's runs (core: "read paths are NOT namespace-scoped"), so scoping is
 * something an operator opts into, never something the client imposes.
 */
export interface RunFilterOptions {
  /** Tenant / worker-pool partition — `WorkflowRun.namespace`, exact match. Absent = all tenants. */
  namespace?: string | undefined;
  /**
   * The package that declared the workflow — `WorkflowRun.origin`, exact match. Absent = all origins.
   * `null` selects the UNATTRIBUTED runs instead (the server's `unattributed` param): a run with no
   * origin matches no string value at all, so absence needs its own spelling. See `run-origin.ts`.
   */
  origin?: string | null | undefined;
}

/** How much of the list to fetch. Absent bounds mean the whole listing — which on a busy control
 *  plane is megabytes and thousands of rows, so the console always sends a `limit`. */
export interface RunPageOptions {
  limit?: number | undefined;
  offset?: number | undefined;
  /** Match ANY of these statuses (`status IN (...)`), for a caller that wants a set rather than the
   *  single `status` argument — e.g. the in-flight runs a singleton leader is chosen among. */
  statuses?: RunStatus[] | undefined;
}

/** One `(status, origin)` count from `GET runs/facets` — mirrors core's `RunFacetRow`. `origin` is
 *  `null` for runs carrying none. */
export interface RunFacetRow {
  status: RunStatus;
  origin: string | null;
  count: number;
}

export const durableClient = {
  /**
   * A page of the run list. The server returns LIST ROWS: `input`, `output` and `error` are omitted
   * (only the detail view renders them, and on a large deployment they are most of the bytes), which
   * is why the three are optional on {@link WorkflowRun}.
   */
  runs(
    status?: RunStatus,
    tag?: string,
    attr?: string[],
    opts?: RunFilterOptions & RunPageOptions,
  ): Promise<WorkflowRun[]> {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (tag) q.set('tag', tag);
    // Each `attr` is a `key:op:value` predicate; repeated params are ANDed server-side.
    for (const a of attr ?? []) q.append('attr', a);
    if (opts?.namespace) q.set('namespace', opts.namespace);
    // `null` is the unattributed bucket, which has its own param — see `RunFilterOptions.origin`.
    if (opts?.origin === null) q.set('unattributed', 'true');
    else if (opts?.origin) q.set('origin', opts.origin);
    // Repeated `status` params are ORed server-side into `RunQuery.statuses`.
    for (const st of opts?.statuses ?? []) q.append('status', st);
    if (opts?.limit !== undefined) q.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return http<WorkflowRun[]>(qs ? `/runs?${qs}` : '/runs');
  },
  /**
   * `(status, origin)` counts for the runs matching the same tag/tenant/attribute predicates as
   * {@link runs} — the console's chips, counted over the WHOLE matching set rather than over the page
   * it happens to be showing. `status`/`origin` are not sent: they are the axes being counted.
   */
  facets(tag?: string, attr?: string[], namespace?: string): Promise<RunFacetRow[]> {
    const q = new URLSearchParams();
    if (tag) q.set('tag', tag);
    for (const a of attr ?? []) q.append('attr', a);
    if (namespace) q.set('namespace', namespace);
    const qs = q.toString();
    return http<RunFacetRow[]>(qs ? `/runs/facets?${qs}` : '/runs/facets');
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
    filter: RunFilterOptions & {
      status?: RunStatus | undefined;
      tag?: string | undefined;
      attr?: string[] | undefined;
    },
  ): Promise<{ matched: number; applied: number }> {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.tag) q.set('tag', filter.tag);
    for (const a of filter.attr ?? []) q.append('attr', a);
    // Every facet the operator can see MUST be sent: a bulk retry/cancel that is scoped more widely
    // than the list it was launched from would act on runs the operator never looked at.
    if (filter.namespace) q.set('namespace', filter.namespace);
    if (filter.origin === null) q.set('unattributed', 'true');
    else if (filter.origin) q.set('origin', filter.origin);
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
  /** Re-dispatch a run's stuck `pending` remote steps — recovery for a lost step dispatch (a crashed
   *  worker or a dropped job). Returns the run's status plus how many steps were re-dispatched. */
  redispatch(id: string): Promise<{ runId: string; status: RunStatus; redispatched: number }> {
    return http<{ runId: string; status: RunStatus; redispatched: number }>(
      `/runs/${encodeURIComponent(id)}/redispatch`,
      { method: 'POST' },
    );
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
export { type SubProcess, groupSubProcesses } from './group-subprocesses.js';

// Re-export the origin facet so external consumers (e.g. flip's embedded pipeline-runs view) spell
// an unattributed run the exact same way this console does — `unknown`, never "app" and never blank.
export {
  ALL_ORIGINS,
  type EmptyRunsNotice,
  type OriginFacet,
  type OriginFilter,
  UNKNOWN_ORIGIN,
  UNKNOWN_ORIGIN_TITLE,
  emptyRunsNotice,
  filterByOrigin,
  isUnknownOrigin,
  knownOrigin,
  matchesOrigin,
  originFacets,
  originFilterKey,
  originLabel,
  sameOriginFilter,
  unknownOriginCount,
} from './run-origin.js';

// Re-export the canonical saga-compensation split so external consumers (e.g. flip) separate a
// run's body from its undo checkpoints the exact same way the dashboard does — by `seq < 0`.
export {
  type CompensationSummary,
  compensationDisplayName,
  compensationSummary,
  splitCompensations,
} from './split-compensations.js';
