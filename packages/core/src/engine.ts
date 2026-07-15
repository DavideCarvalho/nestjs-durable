import { type AdmissionBackend, InMemoryAdmissionBackend } from './admission';
import { runInWorkflowCtx } from './ambient-ctx';
import { backoffDelay } from './backoff';
import { instantCheckpoint, stepCheckpoint } from './checkpoints';
import { type Completion } from './completion';
import { parseDuration } from './duration';
import { Entities, type EntityConfig } from './entities';
import {
  ContinueAsNew,
  FatalError,
  NonDeterminismError,
  RemoteStepTimeout,
  RemoteWorkflowTimeout,
  SignalTimeoutError,
  WorkflowSuspended,
} from './errors';
import { EventAccumulators, type EventBatchConfig } from './event-accumulators';
import {
  EVENT_BUFFER_SCAN_LIMIT,
  eventMatchOf,
  eventMatches,
  eventNameOf,
  eventPrefix,
  isEventToken,
} from './events';
import type {
  ControlPlane,
  EngineEvent,
  EngineListener,
  GroupHealth,
  NamedTransport,
  RemoteTask,
  RunDispatcher,
  RunQuery,
  RunResult,
  RunStatus,
  SearchAttributes,
  SearchAttributesSchema,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  StepDef,
  StepError,
  StepEvent,
  StepInterceptor,
  StepInvocation,
  StepKind,
  StepResult,
  StepUndo,
  Transport,
  UpdateResult,
  UpdateValidator,
  WorkflowCommand,
  WorkflowCtx,
  WorkflowDecision,
  WorkflowExecutor,
  WorkflowRun,
  WorkflowStepEvent,
} from './interfaces';
import type { HistoryEvent } from './interfaces';
import { breakpointToken, stepId } from './protocol';
import type { QueueConfig } from './queue';
import { RemoteWorkflowExecutor } from './remote-workflow-executor';
import { indexWaitersByRun } from './run-waiting';
import { SingletonGate } from './singleton-gate';
import { sanitizeQueueToken, tenantGroup } from './tenant-group';
import { TransportPool } from './transport-pool';
import {
  type Compensation,
  type CtxHost,
  type InternalWorkflowCtx,
  type StepRecord,
  createWorkflowCtx,
} from './workflow-ctx';
import {
  type WorkflowClass,
  type WorkflowInputOf,
  type WorkflowRef,
  workflowName,
} from './workflow-ref';

// The engine ALWAYS runs a body with the InternalWorkflowCtx `createWorkflowCtx` produces (it carries
// the internal `localStep` the entity runner + capture helpers need). Public authors type their body
// with the narrower `WorkflowCtx`; contravariance keeps those assignable to this param, so the internal
// type never leaks into the public authoring surface while `EntityHost.register` still lines up.
type WorkflowFn = (ctx: InternalWorkflowCtx, input: unknown) => Promise<unknown>;

/** Options for {@link WorkflowEngine.start}. */
export interface StartOptions {
  /** Run-scoped tags, merged with the workflow's static `@Workflow({ tags })` onto the run. */
  tags?: string[] | undefined;
  /** Typed, queryable run data stamped on the run (e.g. `{ amount: 200, tier: 'pro' }`). */
  searchAttributes?: SearchAttributes | undefined;
  /**
   * Dispatch priority for a remote run — stamped on the run and carried onto every {@link WorkflowTask}
   * the engine dispatches to advance it. Higher wins; absent = unprioritised. See {@link WorkflowRun.priority}.
   */
  priority?: number | undefined;
  /**
   * Override the namespace stamped on the run. Defaults to the engine's own `namespace`. Set by the
   * control plane when it starts a run on behalf of a tenant (a {@link StartRunMessage}'s `tenant`
   * maps here), so one DB-less-tenant-facing engine can create runs across many namespaces.
   */
  namespace?: string | undefined;
}

/**
 * Serialize runs of a workflow that share a key — a durable, FIFO mutex (e.g. one pipeline per base).
 * Excess runs are admitted in creation order, `limit` at a time; the rest wait (suspended) and retry
 * admission on a timer until a slot frees. Race-free on a consistent store (admission order is the
 * same `(createdAt, id)` view for every instance).
 */
export interface SingletonConfig {
  /** Derive the serialization key from the workflow input. */
  key: (input: unknown) => string;
  /** Max concurrent runs sharing the key. Default 1 (a mutex). */
  limit?: number;
  /**
   * Max GATED (waiting-for-admission) runs allowed to queue behind the `limit` in-flight ones. When
   * set, `start` rejects with {@link SingletonQueueFullError} once in-flight + gated reaches
   * `limit + maxQueueDepth` — back-pressure against an unbounded same-key backlog. Omit for the
   * default unbounded queue. Counts `pending`/`running`/`suspended` runs sharing the key.
   */
  maxQueueDepth?: number;
}

/** Union of a workflow's static tags and a run's start-time tags, de-duplicated, or undefined if none. */
function mergeTags(staticTags?: string[], runTags?: string[]): string[] | undefined {
  if (!staticTags?.length && !runTags?.length) return undefined;
  return [...new Set([...(staticTags ?? []), ...(runTags ?? [])])];
}

/** A breakpoint checkpoint's `name` is `breakpoint` (or `breakpoint:<label>`). This name — not the
 *  reused `signal` kind — is the explicit marker the dashboard and `continue()` detect it by. */
const BREAKPOINT = 'breakpoint';
const isBreakpoint = (cp: { status: string; name: string }): boolean =>
  cp.status === 'pending' && cp.name.startsWith(BREAKPOINT);

interface RegisteredWorkflow {
  name: string;
  version: string;
  fn: WorkflowFn;
  /** Static `@Workflow({ tags })` — merged with per-run tags onto each run at start. */
  tags?: string[] | undefined;
  /** Per-key serialization (a durable mutex). See {@link SingletonConfig}. */
  singleton?: SingletonConfig | undefined;
  /** Max wall-clock lifetime (ms) before a run is cancelled by `sweepTimeouts`. */
  executionTimeoutMs?: number | undefined;
  /** Validate the input at start; throw to reject before a run is created. Validator-agnostic. */
  validateInput?: ((input: unknown) => void | Promise<void>) | undefined;
  /** Typed/validated `searchAttributes` shape. When set, `ctx.upsertSearchAttributes` validates the
   *  merged result against it (see `createWorkflowCtx`). See `WorkflowMeta.searchAttributes`. */
  searchAttributesSchema?: SearchAttributesSchema | undefined;
  /** Event names that start a fresh run of this workflow when published. See `publishEvent`. */
  onEvent?: string[] | undefined;
  /** Coalesce `onEvent` triggers: debounce (fire once it's quiet) or batch (fire on size/window). */
  eventBatch?: EventBatchConfig | undefined;
  /** Set for a workflow advanced by DISPATCH instead of an inline `fn`: a cross-SDK (e.g. Python)
   *  body via {@link WorkflowEngine.registerRemote}, OR a group-served TS body via
   *  `register(..., { group, executor })`. The engine hands the run's history to `executor` (which
   *  dispatches a workflow task to `group`) rather than running `fn` in-process. See
   *  {@link WorkflowExecutor}. */
  remote?: { group: string; executor: WorkflowExecutor };
  /** True when `fn` is a real in-process body (`register`), false/absent for a body-less remote whose
   *  `fn` is the throwing stub (`registerRemote` / a synthesized remote child). Gates
   *  {@link WorkflowEngine.workflowBody} so an in-app worker only ever gets a runnable body. */
  hasBody?: boolean | undefined;
}

const versionKey = (name: string, version: string): string => `${name}@${version}`;

/** The id for the next continuation of a run: `r` → `r~1` → `r~2` … (stable, traceable lineage). */
function nextContinuationId(runId: string): string {
  const m = runId.match(/^(.*)~(\d+)$/);
  return m ? `${m[1]}~${Number(m[2]) + 1}` : `${runId}~1`;
}

/** True when version `a` is newer than `b` (numeric when both parse as numbers, else natural sort). */
function isNewerVersion(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na > nb;
  return a.localeCompare(b, undefined, { numeric: true }) > 0;
}

/** What a remote worker hands back: the output plus when it actually began (for queue-wait timing). */
interface RemoteResolution {
  output: unknown;
  startedAt?: number | undefined;
  events?: StepEvent[] | undefined;
}

interface PendingRemote {
  resolve: (result: RemoteResolution) => void;
  reject: (error: Error) => void;
}

/** A terminal/suspended transition handed to {@link WorkflowEngine.settleRun}. */
type RunOutcome =
  | { kind: 'completed'; output: unknown }
  | { kind: 'failed'; error: StepError }
  | { kind: 'suspended'; wakeAt?: number | undefined };

/**
 * What {@link WorkflowEngine.unwindCompensations} returns when the run must keep waiting on a
 * dispatched compensation — `wakeAt` set while backing off a durable retry (the due-timer poller
 * re-drives it once elapsed), absent while freshly dispatched/in flight (only the worker's result,
 * via `completeRemoteResult`, re-drives it). `undefined` (no `UnwindPending`) means every
 * compensation resolved. Deliberately NOT a `RunResult`: the two callers persist "still unwinding"
 * differently (a plain `suspended` run for the failure path; `cancelling` held as-is for the cancel
 * path — see `compensateAndCancel`), so the settling is left to them.
 */
interface UnwindPending {
  wakeAt?: number | undefined;
}

export interface WorkflowEngineDeps {
  store: StateStore;
  /** A single task transport. Shorthand for a one-entry `transports` pool (id `default`). */
  transport?: Transport | undefined;
  /**
   * An ordered pool of named transports. The engine dispatches on the first and fails over to the
   * next on a dispatch error; a step pins one via `ctx.step(step, input, { transport: id })`. Use
   * this instead of `transport` for failover / multi-broker setups.
   */
  transports?: NamedTransport[] | undefined;
  /**
   * Cross-instance broadcast pub/sub for lifecycle events + cancellation (see {@link ControlPlane}).
   * Separate from the task `transport`; omit for a single-instance / local-only setup. A transport
   * that can also broadcast may be passed here as well.
   */
  controlPlane?: ControlPlane | undefined;
  /** Epoch-ms clock; injectable for tests. Defaults to `Date.now`. */
  clock?: (() => number) | undefined;
  /**
   * Flow-control admission backend for `ctx.step(step, input, { queue })`. Defaults to an in-process
   * {@link InMemoryAdmissionBackend} (per-instance caps). Inject a store/Redis-backed backend to make
   * concurrency / rate-limit / ordering GLOBAL across engine replicas.
   */
  admission?: AdmissionBackend | undefined;
  /** Unique id for this engine instance, used for recovery leases. Defaults to a random id. */
  instanceId?: string | undefined;
  /**
   * Worker-pool partition for this engine. Stamped on every run it creates; the poll paths
   * (`runPending`/`recoverIncomplete`/`resumeDueTimers`/`sweepTimeouts`) only act on runs in this
   * namespace. Set distinct values to safely share ONE state store across non-interchangeable pools
   * (e.g. local dev vs a cluster). **Omit it to make this engine an OPERATOR** — an unset namespace
   * drives/recovers/resumes runs of EVERY namespace (the poll filters no-op, the resume/decision
   * guards fall through) and leaves the transport on its bare prefix. This is the hosted control
   * plane: "ver tudo = ausência de namespace".
   */
  namespace?: string | undefined;
  /** Recovery lease duration in ms — how long this instance owns a run it picked up. Default 30s. */
  leaseMs?: number | undefined;
  /**
   * Cap how many times crash-recovery may pick up the same still-`running` run before giving up and
   * moving it to the `dead` dead-letter state (a poison pill that crashes the process every boot).
   * Omit for unlimited (the default — recovery always retries).
   */
  maxRecoveryAttempts?: number | undefined;
  /**
   * Opt-in liveness deadline (ms) for a remote workflow `advance`. If the worker neither returns a
   * decision NOR sends a run-scoped {@link Heartbeat} within this window, the engine presumes it dead:
   * it rejects the advance with {@link RemoteWorkflowTimeout}, releases the lease, and lets recovery
   * re-drive (replaying completed steps from history). Each beat REARMS the window, so a worker still
   * legitimately replaying a long turn (it keeps beating) is never re-driven — closing the duplicate-
   * side-effect hazard a fixed {@link RemoteWorkflowExecutor} `timeoutMs` cannot avoid. Omit (default)
   * for the prior unbounded await — byte-identical behavior when unset. If a `RemoteWorkflowExecutor` is
   * ALSO constructed with its own `timeoutMs`, the shorter of the two deadlines wins; prefer setting only
   * one (this rearmed window for heartbeat-aware workers, or the fixed `timeoutMs` otherwise).
   */
  remoteAdvanceSilenceMs?: number | undefined;
  /**
   * Fallback re-drive window (ms) for a run that SUSPENDS with no natural timer — i.e. it's waiting on
   * an EVENT to wake it (a child's completion, a signal, a remote step with no `timeoutMs`) rather than
   * a `ctx.sleep`. Those events re-drive the run directly; but if the wake is LOST (the delivering pod
   * crashed / rolled mid-handoff), the run would otherwise sit `suspended` forever with `wakeAt: null` —
   * invisible to both the timer poller (no `wakeAt`) and crash-recovery (no lease). This stamps a
   * fallback `wakeAt` so {@link resumeDueTimers} re-drives it after the window; the re-drive is an
   * idempotent replay (a still-pending dependency re-suspends via the checkpoint guard, a settled one
   * advances), so it's a safe self-heal, not a retry that can double-dispatch. The primary event path
   * still wins first for a healthy run (it re-drives long before this fires), so this only ever fires
   * for a genuinely-orphaned run. Default 5min; set `0` to disable (the prior wake-forever behavior).
   */
  reconcileMs?: number | undefined;
  /**
   * Retention for a BUFFERED event that no `waitForEvent` ever claims (see
   * {@link WorkflowEngine.publishEvent}'s buffering — a publish matching no live waiter keeps ONE
   * copy around for a later matching wait). Default `undefined`: keep it until consumed, same as
   * {@link StateStore.bufferSignal}'s buffered signals — no silent expiry. Set a duration (ms) to
   * have the {@link resumeDueTimers} reconcile pass prune rows past `publishedAt + eventBufferTtlMs`
   * as it encounters them. Scoped to event NAMES the current reconcile tick's registered waiters
   * reference (the sweep has no reason to otherwise enumerate every buffered name) — a name with a
   * stale buffered event but zero waiters ever registered against it is not visited by this pass; that
   * is an accepted gap given `listBufferedEvents` is name-scoped by design (see interfaces.ts), not a
   * bug to route around here.
   */
  eventBufferTtlMs?: number | undefined;
  /**
   * Opt-in self-heal window (ms) for a remote step with NO `timeoutMs` whose dispatched job was LOST —
   * the worker crashed mid-step leaving no result, or the transport dropped the job (a Redis
   * flush/eviction, or BullMQ moving a stalled job to `failed` and removing it). The `pending`
   * checkpoint then has no result to resume on, and — BY DESIGN (see {@link reconcileMs}) — the
   * reconcile re-drive re-suspends a still-pending step rather than re-dispatching, so a slow-but-live
   * worker is never double-run. That safety means a genuinely-lost dispatch would otherwise hang
   * forever. When set, a reconcile re-drive that finds a remote step still `pending` PAST this window
   * re-dispatches it (bumping `attempts`, bounded by {@link remoteRedispatchMax}). Off by default:
   * re-dispatch can double-run a step whose original job is merely slow, so the window MUST exceed the
   * longest such step and the step MUST be idempotent. Prefer a per-step `timeoutMs` (tighter,
   * heartbeat-aware) where you can; this is the store-driven net for no-timeout steps that must
   * survive a lost dispatch. {@link WorkflowEngine.redispatchPending} is the manual counterpart.
   */
  remoteRedispatchMs?: number | undefined;
  /**
   * Max times {@link remoteRedispatchMs} re-dispatches one lost remote step before giving up and
   * failing it as a {@link RemoteStepError} (`code: 'remote_step_lost'`), so the run fails / dead-letters
   * instead of re-dispatching forever. Default 10. Ignored when `remoteRedispatchMs` is unset.
   */
  remoteRedispatchMax?: number | undefined;
  /**
   * Build the public callback URL for a `ctx.webhook()` token (e.g.
   * ``(t) => `https://api.example.com/durable/webhooks/${t}` ``). Populates
   * {@link DurableWebhook.url}. Omit if you build URLs yourself from the token.
   */
  webhookUrl?: ((token: string) => string) | undefined;
  /**
   * Provide the current W3C `traceparent` to stamp on each dispatched {@link RemoteTask}, so a
   * worker (including the Python SDK) continues the distributed trace. Keep core OTel-free: supply
   * `otelTraceparent` from `@dudousxd/nestjs-durable-otel`, or your own context reader. Omit to send none.
   */
  traceparent?: (() => string | undefined) | undefined;
  /**
   * Provide an opaque context carrier (tenant / user / correlation ids) to attach to each dispatched
   * {@link RemoteTask} as its `context`, so a worker (including the Python SDK) re-exposes it to the
   * step handler — cross-process propagation alongside the {@link traceparent}. Keep core dependency-free:
   * supply this from `@dudousxd/nestjs-context` or your own request-scoped reader. The engine never
   * inspects the returned object's shape. Omit to send none.
   *
   * Re-evaluated at each (re)dispatch — including a retry or a resume that the engine drives AFTER a
   * crash/scale-down, which runs OUTSIDE the originating request scope. On such a path this provider
   * may return empty or stale values (the request-scoped tenant/user is gone). Treat the carrier as
   * best-effort correlation/propagation metadata only — do NOT treat it as an authorization boundary.
   */
  context?: (() => Record<string, unknown> | undefined) | undefined;
  /**
   * Re-hydrate the originating context around a LOCAL step body, so a `@DurableStep` reader sees the
   * tenant / user / correlation ids that were live when the run was started — even on a path the
   * engine drives outside the originating request scope (a resume after crash/scale-down, a timer).
   * Given the carrier produced by {@link context} (may be empty/undefined) and the step body `fn`, it
   * runs `fn` with that context ambiently established (e.g. inside `@dudousxd/nestjs-context`'s ALS)
   * and returns its result. Keep core dependency-free: supply this from the nestjs wiring (which owns
   * nestjs-context) or your own ALS bridge. The handler signature is unchanged — re-hydration is
   * ambient. Default: passthrough (`(_, fn) => fn()`), so behavior is byte-identical when unset.
   */
  rehydrate?: (<T>(carrier: Record<string, unknown> | undefined, fn: () => T) => T) | undefined;
  /**
   * Attempts for each saga compensation when the run fails (a transient undo — e.g. a refund API
   * hiccup — gets another try). Default 1 (no retry). Compensations must be idempotent.
   */
  compensationRetries?: number | undefined;
  /**
   * Persist a `running` checkpoint when a local step's body begins, so an in-flight step shows up
   * in the dashboard (and a fresh page load / REST query) the moment it starts — not only once it
   * completes. The `step.started` lifecycle event is emitted either way (the live SSE view always
   * sees the start); this flag only controls the extra checkpoint write. Default `true`. Set
   * `false` on hot paths with many short local steps to halve their checkpoint writes — you keep
   * the live event but lose reload-survivable in-flight visibility.
   */
  trackStepStart?: boolean | undefined;
  /**
   * Where a freshly-`start`ed run executes (see {@link RunDispatcher}). Defaults to in-process: the
   * run executes on this instance asynchronously (a microtask), so `start` returns without blocking.
   * Pass a no-op dispatcher on a caller that must NOT run workflows (e.g. an API/dashboard pod), and
   * run `runPending` on a worker pod to pick those up; or a broker-backed one for a worker pool.
   */
  runDispatcher?: RunDispatcher | undefined;
}

/** Thrown by {@link WorkflowEngine.resume} when the run belongs to a different namespace. */
class NamespaceMismatch extends Error {
  constructor() {
    super('namespace-mismatch');
  }
}

/**
 * The orchestrator. Owns workflow state and replays runs deterministically: each step's
 * result is checkpointed, so on resume a completed step returns its saved output instead of
 * re-executing. Remote steps are dispatched over the Transport; their results checkpoint the
 * same way local steps do.
 */
export class WorkflowEngine {
  private readonly store: StateStore;
  /** Ordered transport pool (dispatch + failover). Empty = no remote steps. */
  private readonly pool: TransportPool;
  private readonly controlPlane?: ControlPlane | undefined;
  private readonly clock: () => number;
  private readonly instanceId: string;
  private readonly namespace: string | undefined;
  private readonly leaseMs: number;
  private readonly maxRecoveryAttempts?: number | undefined;
  private readonly remoteAdvanceSilenceMs?: number | undefined;
  private readonly reconcileMs: number | undefined;
  private readonly eventBufferTtlMs: number | undefined;
  private readonly remoteRedispatchMs: number | undefined;
  private readonly remoteRedispatchMax: number;
  private readonly webhookUrl?: ((token: string) => string) | undefined;
  private readonly traceparent?: (() => string | undefined) | undefined;
  private readonly context?: (() => Record<string, unknown> | undefined) | undefined;
  /** Establish the originating context ambiently around a local step body (see {@link WorkflowEngineDeps.rehydrate}). Default passthrough. */
  private readonly rehydrate: <T>(carrier: Record<string, unknown> | undefined, fn: () => T) => T;
  private readonly compensationRetries: number;
  /** Persist a `running` checkpoint at the start of a local step body (see {@link WorkflowEngineDeps.trackStepStart}). */
  private readonly trackStepStart: boolean;
  /** Where a freshly-started run executes — in-process by default (see {@link RunDispatcher}). */
  private readonly runDispatcher: RunDispatcher;

  /** Per-key serialization for singleton workflows (admission, back-pressure, notify-on-release). */
  private readonly singletons: SingletonGate;
  /** Every registered workflow, keyed by `name@version` — so old versions stay runnable. */
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  /** The newest registered version per workflow name — used to `start` new runs. */
  private readonly latest = new Map<string, RegisteredWorkflow>();
  /** Event name → workflow names started when that event is published (see `onEvent`). */
  private readonly eventTriggers = new Map<string, Set<string>>();
  /** Durable-entity subsystem (registers the `__entity` runner; see `registerEntity`). */
  private readonly entities: Entities;
  /** Event debounce/batch accumulators (register the `__evt_*` runners; see `accumulators.route`). */
  private readonly accumulators: EventAccumulators;
  /** In-flight remote steps awaiting a worker result, keyed by stepId. */
  private readonly pending = new Map<string, PendingRemote>();
  /** "Reset the liveness timer" callbacks keyed by the beat's target — a stepId (in-flight remote step)
   *  or a runId (in-flight remote workflow turn) — invoked when a matching heartbeat arrives. The two id
   *  shapes don't collide in practice: a stepId is `${runId}:${seq}`, a run key is the bare runId. */
  private readonly heartbeatResets = new Map<string, () => void>();
  private readonly listeners = new Set<EngineListener>();
  /** Step interceptors (onion middleware around real local-step execution), first = outermost. */
  private readonly interceptors: StepInterceptor[] = [];
  /** Callbacks notified (on any instance) when a run is cancelled — for cooperative cancellation. */
  private readonly cancelListeners = new Set<(runId: string) => void>();
  /** Callbacks notified when a run is enqueued elsewhere — for low-latency cross-pod dispatch. */
  private readonly enqueuedListeners = new Set<(runId: string) => void>();
  /** Notified when a run is dead-lettered (moved to `dead`) — a hook for a DLQ handler. */
  private readonly deadListeners = new Set<(run: WorkflowRun) => void>();
  /** Validators gating `engine.update`, keyed by `<workflow>:<updateName>`. */
  private readonly updateValidators = new Map<string, UpdateValidator>();
  /** Runs being cancelled WITH saga compensation — see `cancel({ compensate: true })`. */
  private readonly cancelRequested = new Set<string>();
  /** Flow-control admission backend for remote steps (see {@link registerQueue}). */
  private readonly admission: AdmissionBackend;
  /** Runs on THIS instance blocked on admission, by queue — woken early on a freed-slot signal. */
  private readonly queueWaiters = new Map<string, Set<string>>();
  /** Which queue a dispatched step took a slot from, by stepId — so the result can release it. */
  private readonly stepQueue = new Map<string, string>();
  /** Executions currently in flight, so a graceful shutdown can wait for them to settle. */
  private readonly inflight = new Set<Promise<RunResult>>();
  private draining = false;

  constructor(deps: WorkflowEngineDeps) {
    this.store = deps.store;
    this.pool = new TransportPool(
      deps.transports ?? (deps.transport ? [{ id: 'default', transport: deps.transport }] : []),
    );
    this.controlPlane = deps.controlPlane;
    this.clock = deps.clock ?? Date.now;
    this.admission = deps.admission ?? new InMemoryAdmissionBackend(this.clock);
    // Wake this instance's admission-blocked runs the moment a slot frees anywhere in the fleet,
    // instead of waiting for their retry tick. Best-effort (the retry tick remains the guarantee).
    this.admission.onFreed?.((queue) => this.wakeQueueWaiters(queue));
    this.instanceId = deps.instanceId ?? globalThis.crypto.randomUUID();
    this.namespace = deps.namespace;
    // Propagate a SCOPED engine's namespace to its transport(s) so the same namespace that partitions
    // the store also partitions the transport's queues/keys — set once, applied everywhere. An OPERATOR
    // (namespace: undefined) drives every namespace itself, so its transport(s) stay on their
    // constructor prefix (bare/shared) instead of being pinned to one namespace.
    if (this.namespace !== undefined) {
      this.pool.useNamespace(this.namespace);
    }
    this.leaseMs = deps.leaseMs ?? 30_000;
    this.maxRecoveryAttempts = deps.maxRecoveryAttempts;
    this.remoteAdvanceSilenceMs = deps.remoteAdvanceSilenceMs;
    // Default 5min; an explicit 0 disables the fallback (opt back into wake-forever-on-lost-event).
    this.reconcileMs = deps.reconcileMs === undefined ? 300_000 : deps.reconcileMs || undefined;
    // Opt-in: unset (or 0) keeps buffered events around forever, same as buffered signals.
    this.eventBufferTtlMs = deps.eventBufferTtlMs || undefined;
    // Opt-in: unset (or 0) leaves the by-design "re-suspend a lost dispatch, never re-dispatch" behavior.
    this.remoteRedispatchMs = deps.remoteRedispatchMs || undefined;
    this.remoteRedispatchMax = Math.max(1, deps.remoteRedispatchMax ?? 10);
    this.webhookUrl = deps.webhookUrl;
    this.traceparent = deps.traceparent;
    this.context = deps.context;
    // Default passthrough: with no bridge supplied, a local step body runs exactly as before.
    this.rehydrate = deps.rehydrate ?? ((_carrier, fn) => fn());
    this.compensationRetries = Math.max(1, deps.compensationRetries ?? 1);
    this.trackStepStart = deps.trackStepStart ?? true;
    // Default: execute the run on this instance, asynchronously, so `start` never blocks on the body.
    // A failed pickup is swallowed here (the run stays `pending` for a `runPending` poll to retry);
    // run failures themselves are handled inside `execute` and surfaced as the run's `failed` state.
    this.runDispatcher = deps.runDispatcher ?? {
      dispatch: (runId) => queueMicrotask(() => void this.runOne(runId).catch(() => {})),
    };
    this.singletons = new SingletonGate({
      store: this.store,
      clock: this.clock,
      dispatch: (runId) => {
        this.runDispatcher.dispatch(runId);
      },
      configFor: (run) =>
        (
          this.workflows.get(versionKey(run.workflow, run.workflowVersion)) ??
          this.latest.get(run.workflow)
        )?.singleton,
    });
    this.pool.bind(
      async (result) => {
        // In-memory path (a `timeoutMs` step awaiting on THIS instance): resolve its pending promise.
        const waiter = this.pending.get(result.stepId);
        if (waiter) {
          this.pending.delete(result.stepId);
          if (result.status === 'completed') {
            waiter.resolve({
              output: result.output,
              startedAt: result.startedAt,
              events: result.events,
            });
          } else {
            waiter.reject(new RemoteStepError(result.error));
          }
          return;
        }
        // Durable path: no in-memory waiter (the step suspended the run, possibly on another
        // instance) → complete the checkpoint and resume the run here.
        await this.completeRemoteResult(result);
      },
      // A heartbeat resets the liveness window for whatever it targets: an in-flight long STEP (keyed
      // by stepId, see callRemote) or — when stepId is absent — the in-flight workflow TURN (keyed by
      // runId). For an INLINE-advance turn the reset is an in-memory callback; for a DISPATCH-suspend
      // turn there is no in-memory waiter, so a run-scoped beat rearms the suspended turn's durable
      // re-drive deadline (`wakeAt`) instead, keeping a live worker's turn from being re-dispatched.
      async (beat) => {
        const reset = this.heartbeatResets.get(beat.stepId ?? beat.runId);
        if (reset) {
          reset();
          return;
        }
        if (beat.stepId === undefined) await this.rearmDecisionDeadline(beat.runId);
      },
      // A remote workflow worker streams each local step's lifecycle (running → completed/failed) so
      // it's checkpointed live, not all-at-once when the long turn ends.
      async (event) => {
        await this.persistStepEvent(event);
      },
      // A workflow-turn DECISION delivered over the broker — applied durably (by run id) on whatever
      // instance consumes it, NOT correlated to an in-memory promise on the dispatcher. This is the
      // multi-instance fix: a point-to-point broker may hand the decision to a non-dispatching instance.
      async (decision) => {
        await this.completeRemoteDecision(decision);
      },
    );
    // Control-plane start-run: a DB-less tenant worker publishes a StartRunMessage and this
    // (control-plane) engine turns it into a durable run stamped with the tenant's namespace. Guarded
    // by the transport's `onStartRun` capability (like the other optional transport hooks) — a pool
    // whose transport can't carry the channel simply never registers, so a worker-only engine no-ops.
    this.pool.onStartRun(async (message) => {
      await this.start(
        message.workflow,
        message.input,
        message.runId ?? globalThis.crypto.randomUUID(),
        {
          namespace: message.tenant,
          tags: message.tags,
          searchAttributes: message.searchAttributes,
        },
      );
    });
    // Control plane: re-broadcast lifecycle events from OTHER instances to this instance's
    // subscribers (cross-pod live-tail), and act on cancellations issued elsewhere. A broker may
    // echo our own publish back — ignore those (we already handled them locally) to avoid duplicates.
    this.controlPlane?.onControl((msg) => {
      if (msg.from === this.instanceId) return;
      if (msg.kind === 'event') {
        // `at` may be a string after JSON transit (Redis) — normalize back to a Date.
        this.deliver({ ...msg.event, at: new Date(msg.event.at) });
      } else if (msg.kind === 'cancel') {
        this.notifyCancelled(msg.runId);
      } else if (msg.kind === 'enqueued') {
        // A run was enqueued on another instance — let worker subscribers pick it up immediately
        // instead of waiting for the next poll. (Self-broadcasts are already filtered above.)
        for (const fn of this.enqueuedListeners) {
          try {
            fn(msg.runId);
          } catch {
            /* an enqueue listener must not break the engine */
          }
        }
      }
    });
    this.accumulators = new EventAccumulators(this);
    this.entities = new Entities(this);
  }

  /**
   * Register a **durable entity** (a virtual object): a keyed actor whose `handlers` run **serialized
   * per key** over **durable state**, exactly once. Drive it with `signalEntity` (fire) /
   * `ctx.callEntity` (call + await result) and read its state with `getEntityState`. See {@link Entities}.
   */
  registerEntity<S>(name: string, config: EntityConfig<S>): void {
    this.entities.register(name, config);
  }

  /** Send an operation to an entity (fire-and-forget). Ordered + exactly-once per key. */
  signalEntity(name: string, key: string, op: string, arg?: unknown): Promise<void> {
    return this.entities.signal(name, key, op, arg);
  }

  /** Read an entity's current durable state (published after each op), or undefined if it has none yet. */
  getEntityState<S = unknown>(name: string, key: string): Promise<S | undefined> {
    return this.entities.getState<S>(name, key);
  }

  /**
   * Be notified when a run is enqueued on ANOTHER instance (via the control plane), so a worker can
   * pick it up at once — e.g. `engine.onEnqueued((runId) => engine.runOne(runId))`. Returns an
   * unsubscribe function. Only wire this on instances that should execute runs (workers).
   */
  onEnqueued(listener: (runId: string) => void): () => void {
    this.enqueuedListeners.add(listener);
    return () => this.enqueuedListeners.delete(listener);
  }

  /** Fire cooperative-cancellation listeners for `runId` (a worker bridge aborts in-flight work). */
  private notifyCancelled(runId: string): void {
    for (const fn of this.cancelListeners) {
      try {
        fn(runId);
      } catch {
        /* a cancel listener must not break the engine */
      }
    }
  }

  /**
   * Register a workflow version. Register multiple versions of the same name to keep in-flight
   * runs working across a breaking change: old runs resume on the version they started on, new
   * runs start on the newest registered version.
   *
   * GROUP-SERVED (uniform dispatch, opt-in): pass `{ group, executor }` to have the engine DISPATCH
   * this workflow's turns to a worker `group` (via `executor.advance`) instead of running `fn`
   * inline — exactly as {@link registerRemote} does for a cross-SDK (e.g. Python) body, EXCEPT the
   * body is a TS `fn` the engine retains so an IN-APP worker on `group` can fetch it by name
   * ({@link workflowBody}) and run it. This is "one app, both roles": the same process owns the
   * engine AND consumes its own group. Recovery, timers, singleton, cancel and dead-lettering stay
   * engine concerns, identical to a remote run. OMIT `group`/`executor` (the default) to keep the
   * inline fast path — `fn` runs in-process and the run pays zero dispatch round-trips. The first
   * step toward routing every run through a group with no local/remote flag (Phase 3).
   */
  register(
    name: string,
    version: string,
    fn: WorkflowFn,
    opts?: {
      tags?: string[] | undefined;
      singleton?: SingletonConfig | undefined;
      executionTimeout?: string | number | undefined;
      validateInput?: ((input: unknown) => void | Promise<void>) | undefined;
      /** Typed/validated `searchAttributes` shape — see `RegisteredWorkflow.searchAttributesSchema`. */
      searchAttributesSchema?: SearchAttributesSchema | undefined;
      onEvent?: string[] | undefined;
      eventBatch?: EventBatchConfig | undefined;
      /** Worker group to DISPATCH this workflow's turns to (uniform dispatch). Requires `executor`.
       *  Omit for the default inline fast path. See the method doc. */
      group?: string | undefined;
      /** Advances a turn by dispatching a {@link WorkflowTask} to `group`. Requires `group`. For an
       *  in-app worker, pair a transport-backed {@link RemoteWorkflowExecutor} (group consumed by a
       *  worker that calls {@link workflowBody}) so the retained `fn` runs through the transport hop. */
      executor?: WorkflowExecutor | undefined;
    },
  ): void {
    // Group-served is all-or-nothing: a `group` with no `executor` (or vice-versa) is a wiring bug —
    // fail loudly at registration rather than silently falling back to the inline path at dispatch.
    if ((opts?.group == null) !== (opts?.executor == null)) {
      throw new Error(
        `workflow ${name}@${version}: register({ group, executor }) needs BOTH group and executor (or neither)`,
      );
    }
    const registered: RegisteredWorkflow = {
      name,
      version,
      fn,
      tags: opts?.tags,
      singleton: opts?.singleton,
      executionTimeoutMs:
        opts?.executionTimeout != null ? parseDuration(opts.executionTimeout) : undefined,
      validateInput: opts?.validateInput,
      searchAttributesSchema: opts?.searchAttributesSchema,
      onEvent: opts?.onEvent,
      eventBatch: opts?.eventBatch,
      // A real, retained in-process body — so `workflowBody` can hand it to an in-app worker, and so
      // it is NOT confused with the throwing stub `registerRemote` installs for a body-less remote.
      hasBody: true,
    };
    // When group-served, route DISPATCH through the executor (the same `remote` branch a Python
    // workflow takes); `fn` above stays usable for the in-app worker. Omitted = inline fast path.
    if (opts?.group != null && opts?.executor != null) {
      registered.remote = { group: opts.group, executor: opts.executor };
    }
    this.workflows.set(versionKey(name, version), registered);
    const current = this.latest.get(name);
    if (!current || isNewerVersion(version, current.version)) this.latest.set(name, registered);
    for (const event of opts?.onEvent ?? []) {
      const subscribers = this.eventTriggers.get(event) ?? new Set<string>();
      subscribers.add(name);
      this.eventTriggers.set(event, subscribers);
    }
  }

  /**
   * The retained in-process body for `name@version`, for an IN-APP worker that consumes this engine's
   * own group to SERVE a group-served `register(..., { group, executor })` workflow (uniform dispatch):
   * the worker fetches the body by name when it picks up the dispatched {@link WorkflowTask}, replays
   * it, and returns the {@link WorkflowDecision}. `undefined` for an unregistered name or a body-less
   * remote (a `registerRemote` / synthesized child carries only a throwing stub, never handed out).
   */
  workflowBody(name: string, version: string): WorkflowFn | undefined {
    const reg = this.workflows.get(versionKey(name, version));
    return reg?.hasBody ? reg.fn : undefined;
  }

  /**
   * Register a workflow whose body runs in another SDK (e.g. Python). The engine owns the run exactly
   * as for a TS workflow — it persists checkpoints, recovers, runs timers — but advances it by handing
   * the run's history to `executor` (which dispatches a {@link WorkflowTask} to the worker) and applying
   * the {@link WorkflowDecision} the worker's replay returns. The worker never touches the store.
   */
  registerRemote(
    name: string,
    version: string,
    opts: {
      group: string;
      executor: WorkflowExecutor;
      tags?: string[];
      singleton?: SingletonConfig;
      executionTimeout?: string | number;
      validateInput?: (input: unknown) => void | Promise<void>;
    },
  ): void {
    const registered: RegisteredWorkflow = {
      name,
      version,
      // A remote workflow has no in-process body; execute() branches on `remote` before this is read.
      fn: () => {
        throw new Error(`workflow ${name} is remote — it has no in-process body`);
      },
      tags: opts.tags,
      singleton: opts.singleton,
      executionTimeoutMs:
        opts.executionTimeout != null ? parseDuration(opts.executionTimeout) : undefined,
      validateInput: opts.validateInput,
      remote: { group: opts.group, executor: opts.executor },
    };
    this.workflows.set(versionKey(name, version), registered);
    const current = this.latest.get(name);
    if (!current || isNewerVersion(version, current.version)) this.latest.set(name, registered);
  }

  /**
   * The convenience form of {@link registerRemote}: register a workflow whose body runs on a worker
   * `group` (e.g. the Python `durable-worker`, or a separate TS worker), without hand-building a
   * {@link RemoteWorkflowExecutor}. It wires the standard broker executor — a `RemoteWorkflowExecutor`
   * over the engine's own transport, dispatching to `opts.group` — for you, so you write
   * `engine.remote('processing', { group: 'processing' })` instead of
   * `engine.registerRemote('processing', '1', { group: 'processing', executor: new RemoteWorkflowExecutor(transport, 'processing') })`.
   *
   * Defaults the version to `'1'`. All the other {@link registerRemote} options
   * (`tags` / `singleton` / `executionTimeout` / `validateInput`) pass straight through. Reach for the
   * low-level {@link registerRemote} when you need a custom {@link WorkflowExecutor} (a different
   * transport, a fixed `timeoutMs`, a polyglot stub) — `remote()` is the standard wiring on the rails.
   */
  remote(
    name: string,
    opts: {
      /** Worker group this workflow's turns are dispatched to (also the executor's target group). */
      group: string;
      /** Workflow version. Defaults to `'1'`. */
      version?: string;
      tags?: string[];
      singleton?: SingletonConfig;
      executionTimeout?: string | number;
      validateInput?: (input: unknown) => void | Promise<void>;
    },
  ): void {
    const { group, version, ...rest } = opts;
    const executor = new RemoteWorkflowExecutor(this.pool.primary, group);
    this.registerRemote(name, version ?? '1', { group, executor, ...rest });
  }

  /**
   * Register a flow-control queue referenced by `ctx.step(step, input, { queue })`. Caps concurrent
   * in-flight steps and/or the admission rate; blocked calls re-suspend and retry, so the limit is
   * durable. Per engine instance (see {@link QueueConfig}). Registering the same name replaces it.
   */
  registerQueue(config: QueueConfig): void {
    this.admission.register(config);
  }

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Register a {@link StepInterceptor} — onion middleware run around the real execution of every
   * local `ctx.step` (timing, logging, tracing, error enrichment, context propagation). First
   * registered is outermost; interceptors fire only when a step executes, never on replay. Returns
   * an unsubscribe function.
   */
  use(interceptor: StepInterceptor): () => void {
    this.interceptors.push(interceptor);
    return () => {
      const i = this.interceptors.indexOf(interceptor);
      if (i >= 0) this.interceptors.splice(i, 1);
    };
  }

  /**
   * Fold the registered interceptors around a local step body (identity when there are none), then
   * run the whole thing inside the re-hydrated originating context. The carrier is read at execution
   * time from {@link context} — the SAME reader stamped on dispatched remote tasks — so a local step
   * sees the live tenant / user / trace ids ambiently (via the {@link rehydrate} bridge). Default
   * `rehydrate` is a passthrough, so this is byte-identical to a bare body call when unwired.
   */
  private interceptStep<T>(invocation: StepInvocation, body: () => Promise<T>): Promise<T> {
    const carrier = this.context?.();
    const run = (): Promise<T> => {
      if (this.interceptors.length === 0) return body();
      const chain = this.interceptors.reduceRight<() => Promise<unknown>>(
        (next, interceptor) => () => interceptor(invocation, next),
        body as () => Promise<unknown>,
      );
      return chain() as Promise<T>;
    };
    return this.rehydrate(carrier, run);
  }

  /**
   * Be notified when a run is cancelled — on ANY instance, via the transport control plane. A
   * worker bridge can use this for cooperative cancellation: abort the in-flight work for `runId`
   * instead of finishing it just to have the result discarded. Returns an unsubscribe function.
   */
  onCancel(listener: (runId: string) => void): () => void {
    this.cancelListeners.add(listener);
    return () => this.cancelListeners.delete(listener);
  }

  /**
   * Be notified when a run is **dead-lettered** — moved to `dead` after exceeding
   * `maxRecoveryAttempts`. The listener receives the dead run (status `dead`, with its error), so a
   * DLQ handler can do something other than just leaving it parked: alert, push to a real queue, or
   * start a dead-letter workflow (e.g. `engine.onDead((run) => engine.start('pipeline-dlq', run, ...))`).
   * Returns an unsubscribe function.
   */
  onDead(listener: (run: WorkflowRun) => void): () => void {
    this.deadListeners.add(listener);
    return () => this.deadListeners.delete(listener);
  }

  private notifyDead(run: WorkflowRun): void {
    for (const fn of this.deadListeners) {
      try {
        fn(run);
      } catch {
        /* a dead-letter handler must not break recovery */
      }
    }
  }

  /** Emit a locally-produced lifecycle event: deliver to subscribers AND broadcast it on the
   *  control plane so other instances (e.g. a dashboard pod) can live-tail this run. */
  private emit(event: Omit<EngineEvent, 'at'>): void {
    const full: EngineEvent = { ...event, at: new Date() };
    this.deliver(full);
    if (this.controlPlane) {
      void this.controlPlane
        .publishControl({ kind: 'event', event: full, from: this.instanceId })
        .catch(() => {
          // control-plane delivery is best-effort observability; never break execution
        });
    }
  }

  /** Deliver an event to local subscribers only (no re-broadcast) — used for both locally-produced
   *  events and ones received from the control plane, so an event shows up once on every instance. */
  private deliver(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a misbehaving subscriber must never break workflow execution
      }
    }
  }

  async start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  async start<TInput>(
    workflow: string,
    input: TInput,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  async start(
    workflow: WorkflowRef,
    input: unknown,
    runId: string,
    opts?: StartOptions,
  ): Promise<RunResult> {
    const name = workflowName(workflow);
    let registered = this.latest.get(name);
    if (!registered) {
      // An unregistered run inherits remote routing from its spawning ancestor (see
      // {@link findInheritedRegistration}): the child of a remote workflow can be started without a
      // redundant `registerRemote` for its name. The child run doesn't exist yet, but its parent
      // already wrote the `child:<runId>` waiter BEFORE calling start (the remote `startChild` command
      // and `ctx.child`/`ctx.all` all put the waiter first), so the ancestor is discoverable now.
      const ancestor = await this.findRemoteAncestor(runId);
      if (ancestor) registered = this.synthesizeRemoteChild(name, ancestor.version, ancestor);
    }
    if (!registered) {
      // Convention routing: if the transport reports a live group of the same name, synthesize a
      // remote registration on the fly. Version '1' is the convention default (same as engine.remote()).
      const conventionRun: WorkflowRun = {
        id: runId,
        workflow: name,
        workflowVersion: '1',
        status: 'pending',
        // Stamp the namespace the REAL run will carry (below) so convention routing resolves the same
        // tenant-suffixed group the run will dispatch to — an operator starting a tenant's run via the
        // `onStartRun` wire (opts.namespace = tenant) must find the live `<workflow>@<tenant>` group,
        // not the bare group. Without this the start-run entry path can't reach a suffixed-only worker.
        namespace: opts?.namespace ?? this.namespace,
        input,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      registered = await this.resolveRemoteByConvention(conventionRun);
    }
    if (!registered) throw new Error(`workflow ${name} is not registered`);
    // Validate the input up front — a bad payload is rejected before any run is created.
    await registered.validateInput?.(input);
    // Idempotent by run id: a redelivered trigger (at-least-once queues) or a scheduler re-tick for
    // the same id is a no-op, returning the existing run's state instead of starting a duplicate.
    const prior = await this.store.getRun(runId);
    if (prior) {
      return { runId, status: prior.status, output: prior.output, error: prior.error };
    }
    const now = new Date();
    // A singleton workflow stamps a `singleton:<key>` tag so the admission gate (in execute) can find
    // the other in-flight runs sharing the key via a tag+status query.
    const tags = mergeTags(
      registered.tags,
      registered.singleton
        ? [...(opts?.tags ?? []), this.singletons.tag(registered.singleton, input)]
        : opts?.tags,
    );
    // Singleton back-pressure: reject a start that would grow the same-key backlog past
    // `limit + maxQueueDepth` (no-op when no maxQueueDepth is configured).
    if (registered.singleton) {
      await this.singletons.assertCapacity(name, registered.singleton, input);
    }
    const run: WorkflowRun = {
      id: runId,
      workflow: name,
      workflowVersion: registered.version,
      status: 'pending',
      namespace: opts?.namespace ?? this.namespace,
      input,
      tags,
      searchAttributes: opts?.searchAttributes,
      priority: opts?.priority,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);
    // The run is durably enqueued; a dispatcher (in-process by default) executes it — `start` does
    // NOT run the body inline. Await the terminal/suspended state with `waitForRun(runId)` if needed.
    await this.runDispatcher.dispatch(runId);
    // Nudge worker instances to pick it up now instead of on their next poll (no-op without a control
    // plane; self-receipt is filtered, so it only helps OTHER pods — e.g. an API pod's enqueue).
    if (this.controlPlane) {
      void this.controlPlane
        .publishControl({ kind: 'enqueued', runId, from: this.instanceId })
        .catch(() => undefined);
    }
    return { runId, status: 'pending' };
  }

  /** Read a run's current persisted state (or null if unknown). A thin pass-through to the store. */
  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.store.getRun(runId);
  }

  async resume(runId: string): Promise<RunResult> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    // A definitively-finished run must not be re-executed (e.g. a worker result landing after the
    // run was cancelled, or a duplicate resume) — that would replay the body and clobber the
    // terminal state. `failed` is intentionally NOT terminal here: retry resumes a failed run.
    if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'dead') {
      return { runId, status: run.status, output: run.output, error: run.error };
    }
    // Namespace guard: release the lock and bail when this run belongs to a different worker pool.
    // Piggybacked on the existing store.getRun above — no extra async step on the happy path.
    // An undefined namespace (a store adapter that doesn't persist the field yet) is treated as
    // "belongs to everyone" for back-compat: don't skip it. Likewise, this ENGINE having an
    // undefined namespace means it's an operator control plane — it belongs to every namespace too,
    // so the guard never applies to it.
    if (
      this.namespace !== undefined &&
      run.namespace !== undefined &&
      run.namespace !== this.namespace
    ) {
      await this.store.releaseRunLock(runId);
      throw new NamespaceMismatch();
    }
    // Pin to the version the run STARTED on — replay is positional, so running a changed
    // workflow body against old checkpoints would corrupt the run. The direct lookup is synchronous
    // (`??` short-circuits): a registered run never awaits here, so its resume timing is unchanged —
    // only an UNREGISTERED run pays the inheritance walk (see {@link findInheritedRegistration}).
    const registered =
      this.workflows.get(versionKey(run.workflow, run.workflowVersion)) ??
      (await this.findInheritedRegistration(run)) ??
      (await this.resolveRemoteByConvention(run));
    if (!registered) {
      throw new Error(
        `workflow ${run.workflow}@${run.workflowVersion} is not registered — keep the prior version deployed so in-flight runs can drain (skew protection)`,
      );
    }
    return this.track(this.execute(run, registered.fn));
  }

  /**
   * The registration for an UNREGISTERED run, INHERITED from its nearest REMOTE ancestor — or
   * `undefined` if it has none (the skew-protection error case in {@link resume}). Callers check the
   * flat registry FIRST (so an explicit `registerRemote(name, …)` ALWAYS wins, and a registered run
   * never reaches here); this resolves only the new case: a child spawned by a remote workflow (e.g. a
   * Python `gather_children` / `start_child` fan-out) of a name the host never `registerRemote`-ed. It
   * is driven as a remote run on the ancestor's group + the SAME executor instance, so the host needs
   * no redundant registration per child name.
   *
   * RECOMPUTED per resume rather than memoized into `this.workflows`: a synthesized child is not a real
   * registration and must not leak into `latest`, `knownGroups`, or `sweepTimeouts` (which iterate the
   * registry); recomputing also stays correct if the ancestor's remote registration is re-pointed at a
   * new executor across a deploy. Only unregistered runs pay it, so registered workflows pay nothing.
   */
  private async findInheritedRegistration(
    run: WorkflowRun,
  ): Promise<RegisteredWorkflow | undefined> {
    const ancestor = await this.findRemoteAncestor(run.id);
    if (!ancestor) return undefined;
    return this.synthesizeRemoteChild(run.workflow, run.workflowVersion, ancestor);
  }

  /**
   * A throwaway {@link RegisteredWorkflow} that routes `name@version` as a remote run on the ancestor's
   * group via the ancestor's SAME executor instance. The executor is group-scoped (it dispatches a
   * {@link WorkflowTask} carrying `run.workflow`, and the worker picks the body by name), so reusing it
   * is correct AND required — a second executor on the same group would race the worker for results.
   * Only `remote` is inherited; the child gets none of the ancestor's singleton/timeout/validator, so
   * its identity stays its own.
   */
  private synthesizeRemoteChild(
    name: string,
    version: string,
    ancestor: RegisteredWorkflow,
  ): RegisteredWorkflow {
    // `ancestor` always carries `remote` (findRemoteAncestor / start only pass a remote registration);
    // the guard narrows the optional type without an unsafe cast and documents the invariant.
    const remote = ancestor.remote;
    if (!remote) throw new Error(`workflow ${ancestor.name} is not a remote workflow`);
    return {
      name,
      version,
      fn: () => {
        throw new Error(`workflow ${name} is remote — it has no in-process body`);
      },
      remote,
    };
  }

  /**
   * Attempt to route an unregistered workflow to the live worker group of the same name: if the
   * transport reports a live heartbeat for group `run.workflow`, synthesize a throwaway
   * {@link RegisteredWorkflow} that dispatches to that group over the primary transport. Returns
   * `undefined` when the group is not live. Always attempted — there is no opt-in flag; an explicit
   * `register`/`registerRemote` still takes precedence (this only runs when nothing is registered).
   *
   * Recomputed per call (never memoized into `this.workflows`) so it stays correct if group
   * liveness changes between calls, exactly as {@link synthesizeRemoteChild} does.
   */
  private async resolveRemoteByConvention(
    run: WorkflowRun,
  ): Promise<RegisteredWorkflow | undefined> {
    // Workers register/heartbeat their liveGroups under the SANITIZED token (`sanitizeQueueToken`),
    // so the membership check must sanitize too — else a `:`-named workflow's live worker is under
    // `orders-fulfill` while this computes `orders:fulfill` and never matches.
    const group = tenantGroup(sanitizeQueueToken(run.workflow), run.namespace);
    // Resolve the TRANSPORT the group is live on, not just membership in the merged list: in a
    // mixed pool (a tenant-scoped control plane pairing its namespaced transport with a bare-prefix
    // one for operator-convention tenant workers), each transport scans a different keyspace —
    // dispatching on `primary` while the worker heartbeats on another transport would park the turn
    // on a queue nobody consumes.
    const liveTransport = await this.pool.transportWithLiveGroup(group);
    if (!liveTransport) return undefined;
    // Feed the workflow NAME + namespace-as-partition through, rather than the pre-combined
    // `group` string above — the executor computes the identical token itself (name+partition is
    // the new routing primitive; `group` here still exists only for the liveGroups membership check).
    const executor = new RemoteWorkflowExecutor(liveTransport, run.workflow, run.namespace);
    return {
      name: run.workflow,
      version: run.workflowVersion,
      fn: () => {
        throw new Error(`remote workflow ${run.workflow} has no local body`);
      },
      hasBody: false,
      remote: { group, executor },
    };
  }

  /**
   * Walk the parent chain of `childRunId` to the nearest ancestor registered as REMOTE, returning its
   * registration (or `undefined` if there is none). The parent of an awaited child is found via its
   * live `child:<childId>` signal waiter — present for as long as the parent is suspended awaiting the
   * child, i.e. throughout the child's executable lifetime (start, every resume, crash recovery, cancel
   * cascade), which is exactly when we resolve. A registered-but-LOCAL parent stops the walk (an
   * unregistered child of a TS workflow is a genuine misconfiguration → skew error); only an
   * unregistered parent keeps walking, so a child of an inherited child still reaches the remote root.
   * `visited` guards against a pathological cyclic id graph.
   */
  private async findRemoteAncestor(
    childRunId: string,
    visited = new Set<string>(),
  ): Promise<RegisteredWorkflow | undefined> {
    if (visited.has(childRunId)) return undefined;
    visited.add(childRunId);
    const parentRunId = await this.findParentRunId(childRunId);
    if (!parentRunId) return undefined;
    const parent = await this.store.getRun(parentRunId);
    if (!parent) return undefined;
    const parentReg = this.workflows.get(versionKey(parent.workflow, parent.workflowVersion));
    if (parentReg?.remote) return parentReg;
    if (parentReg) return undefined;
    return this.findRemoteAncestor(parent.id, visited);
  }

  /**
   * The run that spawned `childRunId`, via its live `child:<childRunId>` signal waiter — every awaited
   * child (`ctx.child`, `ctx.all`, a remote `start_child`) suspends its parent on exactly this waiter,
   * and the waiter is written BEFORE the child is started. Only reached for an UNREGISTERED child, so
   * registered runs never pay the scan; returns `undefined` once the parent has settled the child (the
   * waiter is consumed), but by then the child is terminal and no longer resolved.
   */
  private async findParentRunId(childRunId: string): Promise<string | undefined> {
    const token = `child:${childRunId}`;
    for (const waiter of await this.store.listSignalWaiters('child:')) {
      if (waiter.token === token) return waiter.runId;
    }
    return undefined;
  }

  /** Track an in-flight execution so {@link drain} can wait for it. */
  private track(p: Promise<RunResult>): Promise<RunResult> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  /**
   * Graceful shutdown: stop picking up new runs (recovery/timer become no-ops) and wait for
   * in-flight executions to settle, up to `timeoutMs`. Call from your app's shutdown hook so a
   * deploy hands off cleanly instead of leaving runs to the lease timeout.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    if (this.inflight.size === 0) return;
    const timer = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      (t as { unref?: () => void }).unref?.();
    });
    await Promise.race([Promise.allSettled([...this.inflight]), timer]);
  }

  /**
   * Cancel in-flight runs that have outlived their workflow's `executionTimeout`. Call it from the
   * timer poller alongside {@link resumeDueTimers}. A timed-out run is moved to `cancelled` with an
   * `execution_timeout` error (terminal, so a late step result can't resurrect it).
   */
  async sweepTimeouts(now: number = this.clock()): Promise<void> {
    for (const reg of new Set(this.latest.values())) {
      if (reg.executionTimeoutMs == null) continue;
      const deadline = now - reg.executionTimeoutMs;
      const inflight = [
        ...(await this.store.listRuns({
          workflow: reg.name,
          status: 'running',
          namespace: this.namespace,
        })),
        ...(await this.store.listRuns({
          workflow: reg.name,
          status: 'suspended',
          namespace: this.namespace,
        })),
      ];
      for (const run of inflight) {
        if (run.createdAt.getTime() > deadline) continue;
        const error = { message: 'execution timeout', code: 'execution_timeout' };
        await this.store.updateRun(run.id, { status: 'cancelled', error, updatedAt: new Date() });
        this.emit({
          type: 'run.failed',
          runId: run.id,
          workflow: run.workflow,
          namespace: run.namespace,
          error,
        });
      }
    }
  }

  /**
   * Resume every run left incomplete by a crash or deploy. Called on boot. Completed steps
   * replay from their checkpoints, so only the work that had not finished runs again.
   */
  async recoverIncomplete(nowMs: number = this.clock()): Promise<RunResult[]> {
    if (this.draining) return [];
    const results: RunResult[] = [];
    for (const run of await this.store.listIncompleteRuns(this.namespace)) {
      // A live worker renews its lease, so an acquirable lease means the run is genuinely orphaned
      // (its worker crashed). Skip the ones still owned.
      const acquired = await this.store.tryLockRun(
        run.id,
        this.instanceId,
        nowMs + this.leaseMs,
        nowMs,
      );
      if (!acquired) continue;
      // Count the attempt / dead-letter a poison pill past maxRecoveryAttempts.
      const settled = await this.countRecovery(run);
      if (settled) {
        results.push(settled);
        continue;
      }
      // Re-enqueue rather than resume inline: recovery must NOT block (boot, or a poll tick) on a
      // long workflow step. A dispatcher/worker re-runs it, replaying its checkpoints.
      await this.store.releaseRunLock(run.id);
      // A `cancelling` run keeps its status (resetting to `pending` would lose the persisted cancel
      // intent and resurrect the run): the re-driven turn re-derives it from the status and finishes
      // the cancel. Every other run re-enqueues as `pending` for a clean (re)start.
      if (run.status !== 'cancelling') {
        await this.store.updateRun(run.id, { status: 'pending', updatedAt: new Date() });
      }
      await this.runDispatcher.dispatch(run.id);
      results.push({
        runId: run.id,
        status: run.status === 'cancelling' ? 'cancelling' : 'pending',
      });
    }
    return results;
  }

  /**
   * Per-recovery bookkeeping (called once the lease is held): count the attempt, or — past
   * `maxRecoveryAttempts` — move a poison pill to the `dead` dead-letter state. Returns a terminal
   * result to skip the resume, or `undefined` to proceed.
   */
  private async countRecovery(run: WorkflowRun): Promise<RunResult | undefined> {
    const attempts = (run.recoveryAttempts ?? 0) + 1;
    if (this.maxRecoveryAttempts != null && attempts > this.maxRecoveryAttempts) {
      const error = {
        message: `run exceeded maxRecoveryAttempts (${this.maxRecoveryAttempts}) — moved to dead-letter`,
        code: 'max_recovery_attempts',
      };
      await this.store.updateRun(run.id, { status: 'dead', error, updatedAt: new Date() });
      await this.store.releaseRunLock(run.id);
      this.emit({
        type: 'run.failed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        error,
      });
      this.notifyDead({ ...run, status: 'dead', error, recoveryAttempts: attempts });
      return { runId: run.id, status: 'dead', error };
    }
    // Count BEFORE resuming, so a crash mid-resume still advances the counter.
    await this.store.updateRun(run.id, { recoveryAttempts: attempts, updatedAt: new Date() });
    return undefined;
  }

  /**
   * Resume every suspended run whose durable timer is due. Call periodically (a poller) and on
   * boot. A run still not due re-suspends cheaply without running new work.
   *
   * Piggy-backs the signal/event-waiter reconcile safety net (see {@link reconcileSignalWaiter}): a
   * crash between the waiter/buffer pairing ops on EITHER side (this run's own `putSignalWaiter` →
   * `takeBufferedSignal`/`listBufferedEvents`, or the other side's `takeSignalWaiter`/fan-out →
   * `bufferSignal`/`bufferEvent` → re-check — see `signal`'s interleaving proof, which `publishEvent`
   * mirrors for events) can leave both rows stranded with nothing left to pair them: the waiter's turn
   * already suspended, the other side that buffered it already returned. Event-wait suspends already
   * carry a `reconcileMs` fallback `wakeAt` (see {@link reconcileWakeAt}) precisely so they show up
   * HERE — that's what makes this due-timer pass the natural place for the sweep (and, for events, also
   * where an `eventBufferTtlMs` prune piggy-backs — see {@link reconcileBufferedEvent}). One bulk waiter
   * scan, filtered to just this tick's batch, keeps it cheap regardless of store size.
   */
  async resumeDueTimers(nowMs: number = this.clock()): Promise<RunResult[]> {
    const due = await this.store.listDueTimers(nowMs, this.namespace);
    if (due.length === 0) return [];
    const waiterByRun = indexWaitersByRun(await this.store.listSignalWaiters(''));
    return this.resumeLeased(due, nowMs, (run) =>
      this.reconcileSignalWaiter(run, waiterByRun.get(run.id)),
    );
  }

  /**
   * The reconcile safety net's per-run check (see {@link resumeDueTimers}): if this suspended run has
   * a registered signal OR event waiter and a matching payload is already buffered, pair and deliver
   * them directly instead of falling through to a full replay. Child/breakpoint waiter tokens are
   * never buffered (a child/breakpoint notifies via `signal` only once its counterpart is already
   * registered) — `takeBufferedSignal` on those is a guaranteed miss, so this only ever does real work
   * for a plain signal or an event waiter (classified via {@link isEventToken}).
   *
   * Also opportunistically prunes expired buffered EVENTS for this waiter's name when
   * {@link eventBufferTtlMs} is set (see its doc — scoped to names a registered waiter references in
   * this tick's batch, piggy-backing the SAME scan rather than a separate pass), even on a miss.
   *
   * Returns `undefined` (not settled — `resumeLeased` proceeds with its normal `resume`) when there's
   * no waiter or no buffered hit. Deliberately never returns `null`: a delivered signal always resumes
   * via {@link deliverSignal}, and even a `NamespaceMismatch` there is reported as a real (non-nullish)
   * result — returning `null` would read as "not settled" to `resumeLeased`'s `??` fallback and
   * trigger a second, redundant `resume` call on the same run.
   */
  private async reconcileSignalWaiter(
    run: WorkflowRun,
    waiter: SignalWaiter | undefined,
  ): Promise<RunResult | undefined> {
    if (!waiter) return undefined;
    if (isEventToken(waiter.token)) return this.reconcileBufferedEvent(run, waiter);
    const buffered = await this.store.takeBufferedSignal(waiter.token);
    if (!buffered) return undefined;
    await this.store.removeSignalWaiter(waiter);
    const settled = await this.deliverSignal(waiter, buffered.payload);
    return settled ?? { runId: run.id, status: run.status };
  }

  /**
   * The EVENT half of {@link reconcileSignalWaiter}: scan this waiter's name for a matching buffered
   * event (same list+evaluate+claim shape as `waitForEvent`'s own consumption — the match predicate
   * belongs to the waiter, never the store), pruning any expired candidates it encounters along the
   * way when {@link eventBufferTtlMs} is configured. A pruned-but-non-matching candidate does not stop
   * the scan; only a MATCHING hit (or exhausting the scan window) does.
   */
  private async reconcileBufferedEvent(
    run: WorkflowRun,
    waiter: SignalWaiter,
  ): Promise<RunResult | undefined> {
    const name = eventNameOf(waiter.token);
    const match = eventMatchOf(waiter.token);
    const candidates = await this.store.listBufferedEvents(name, EVENT_BUFFER_SCAN_LIMIT);
    const nowMs = this.clock();
    for (const candidate of candidates) {
      if (this.eventBufferTtlMs != null && nowMs - candidate.publishedAt > this.eventBufferTtlMs) {
        await this.store.removeBufferedEvent(candidate.id); // expired — prune regardless of match
        continue;
      }
      if (!eventMatches(candidate.payload, match)) continue;
      if (!(await this.store.removeBufferedEvent(candidate.id))) continue; // raced away — try the next
      await this.store.removeSignalWaiter(waiter);
      const settled = await this.deliverSignal(waiter, candidate.payload);
      return settled ?? { runId: run.id, status: run.status };
    }
    return undefined;
  }

  /**
   * Lease and execute one run by id — the worker side of dispatch. Acquires the recovery lease (so
   * exactly one instance runs it), then resumes the body. Returns the result, or null if another
   * instance holds the lease or the engine is draining. The default in-process dispatcher calls this;
   * a broker-backed worker calls it per consumed run id.
   */
  async runOne(runId: string): Promise<RunResult | null> {
    if (this.draining) return null;
    const nowMs = this.clock();
    const acquired = await this.store.tryLockRun(
      runId,
      this.instanceId,
      nowMs + this.leaseMs,
      nowMs,
    );
    if (!acquired) return null;
    // resume() checks the namespace and throws NamespaceMismatch when it doesn't match — no extra
    // await before the call, so the microtask ordering (critical for cancel-safety) is unchanged.
    return this.resume(runId).catch((err) => {
      if (err instanceof NamespaceMismatch) return null;
      throw err;
    });
  }

  /**
   * Re-enqueue a run for a worker to (re-)execute — the dispatch-model **retry**. Sets it back to
   * `pending`, clears any stale lease, and dispatches; a worker resumes it (replaying its checkpoints,
   * re-attempting the failed step). Returns the enqueued state immediately — never runs the body
   * inline — or null if the run is unknown. The dashboard "retry" goes through here so it can't block
   * the HTTP request on workflow execution.
   */
  async requeue(runId: string): Promise<RunResult | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    await this.store.releaseRunLock(runId);
    await this.store.updateRun(runId, { status: 'pending', updatedAt: new Date() });
    await this.runDispatcher.dispatch(runId);
    return { runId, status: 'pending' };
  }

  /**
   * Explicitly re-dispatch every remote step of `runId` stuck `pending` — the OPERATOR escape hatch for
   * a run whose dispatched step job was LOST (worker crashed with no result, or a transport that dropped
   * the job). No automatic recovery re-drives these: a reconcile re-drive re-suspends a still-pending
   * step by design (unless `remoteRedispatchMs` is set), `recoverIncomplete` only reclaims LEASED runs,
   * and `requeue` just replays back to the pending guard. This re-enqueues the same `stepId` so the
   * (idempotent) step re-runs and its result resumes the run. Safe to call on a healthy run — it re-runs
   * only in-flight `pending` remote steps, which are idempotent by the durable contract. Returns the
   * run's current status (with the count re-dispatched), or null if the run is unknown.
   */
  async redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const pending = (await this.store.listCheckpoints(runId)).filter(
      (cp) => cp.kind === 'remote' && cp.status === 'pending',
    );
    let redispatched = 0;
    for (const cp of pending) {
      if (!cp.stepId) continue;
      const reAttempt = cp.attempts + 1;
      const reEnqueuedAt = new Date();
      await this.store.saveCheckpoint({
        ...cp,
        attempts: reAttempt,
        enqueuedAt: reEnqueuedAt,
        startedAt: reEnqueuedAt,
        finishedAt: reEnqueuedAt,
      });
      await this.dispatchRemoteTask({
        runId,
        seq: cp.seq,
        name: cp.name,
        stepId: cp.stepId,
        group: cp.workerGroup ?? sanitizeQueueToken(cp.name),
        input: cp.input,
        attempt: reAttempt,
      });
      redispatched += 1;
    }
    return { runId, status: run.status, redispatched };
  }

  /**
   * **Fix-and-replay**: re-run a run (typically a `dead`/`failed` one) with a corrected `input`, as a
   * fresh run with clean history. It's a NEW run — `newRunId` defaults to `<runId>~retry~<uuid>` — so
   * the original stays inspectable. Returns the new run's id, or null if `runId` is unknown.
   */
  async retryWithInput(
    runId: string,
    input: unknown,
    newRunId?: string,
  ): Promise<{ runId: string } | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const id = newRunId ?? `${runId}~retry~${globalThis.crypto.randomUUID().slice(0, 8)}`;
    // Inherit the original run's namespace so a retry of a tenant's run stays that tenant's — on an
    // operator (this.namespace === undefined) an unstamped retry would fall to 'default' and route to
    // the bare worker group, orphaning it if only the tenant-suffixed worker is live.
    await this.start(run.workflow, input, id, { tags: run.tags, namespace: run.namespace });
    return { runId: id };
  }

  /**
   * Pick up and execute every `pending` run — the poll-based side of dispatch for a worker pod with
   * no broker. Runs enqueued by other pods (or by a caller using a no-op dispatcher) sit `pending`
   * in the store until polled; leasing ensures exactly one pod runs each. Call periodically alongside
   * {@link resumeDueTimers}.
   */
  async runPending(nowMs: number = this.clock()): Promise<RunResult[]> {
    // Oldest-first (FIFO), capped per call so a backlog drains over several polls without one sweep
    // fetching unboundedly. A run not picked up this tick is picked up the next.
    return this.resumeLeased(await this.store.listPendingRuns(100, this.namespace), nowMs);
  }

  /**
   * Resolve once `runId` reaches a settled state — terminal (completed/failed/cancelled/dead) or
   * suspended (handed off to a timer/signal/event). The async counterpart to dispatch: pair it with
   * `start` when a call site needs the outcome — `await start(...); const r = await waitForRun(id)`.
   */
  waitForRun(
    runId: string,
    opts?: { timeoutMs?: number; until?: 'settled' | 'terminal' },
  ): Promise<RunResult> {
    // `cancelling` is NON-terminal (the saga undo is still running), so a `waitForRun` after a
    // compensating cancel keeps waiting until the run reaches the terminal `cancelled`.
    //
    // A run in the DISPATCH-AND-SUSPEND liveness state — `suspended` while still awaiting a dispatched
    // workflow TURN's decision (`awaitingDecisionTaskId` set) — is mid-turn, NOT settled: that
    // `suspended` is the engine's re-drive marker, not a body-emitted sleep/signal suspend. Resolving on
    // it would hand back a half-applied turn (e.g. a sleep whose `wakeAt` the decision hasn't written
    // yet). Wait until the decision lands and clears the marker (a real suspend) or the run goes terminal.
    //
    // `until: 'terminal'` skips settling on a real suspend too — it resolves only on
    // completed/failed/cancelled/dead (the wait behind `MyWorkflow.execute()` outside a workflow).
    const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'dead']);
    const isSettled = (run: WorkflowRun): boolean =>
      opts?.until === 'terminal'
        ? TERMINAL.has(run.status)
        : run.status !== 'pending' &&
          run.status !== 'running' &&
          run.status !== 'cancelling' &&
          !(run.status === 'suspended' && run.awaitingDecisionTaskId !== undefined);
    const toResult = (run: WorkflowRun): RunResult => ({
      runId,
      status: run.status,
      output: run.output,
      error: run.error,
    });
    return new Promise<RunResult>((resolve, reject) => {
      let done = false;
      let off: () => void = () => {};
      const timer =
        opts?.timeoutMs != null
          ? setTimeout(() => {
              if (done) return;
              done = true;
              if (poller) clearInterval(poller);
              off();
              reject(new Error(`waitForRun(${runId}) timed out after ${opts.timeoutMs}ms`));
            }, opts.timeoutMs)
          : undefined;
      const finish = (run: WorkflowRun): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (poller) clearInterval(poller);
        off();
        resolve(toResult(run));
      };
      const check = (): void => {
        void this.store.getRun(runId).then((run) => {
          if (run && isSettled(run)) finish(run);
        });
      };
      // Terminal mode also polls: cancelled/dead transitions have no `run.*` lifecycle event to
      // react to (and a resume may happen on ANOTHER instance), so events alone can miss them.
      const poller =
        opts?.until === 'terminal'
          ? (() => {
              const interval = setInterval(check, 250);
              interval.unref?.();
              return interval;
            })()
          : undefined;
      // React only to this run's settling events (not its every step event), and subscribe BEFORE the
      // initial read so a run that settles in between isn't missed.
      off = this.subscribe((ev) => {
        if (
          ev.runId === runId &&
          (ev.type === 'run.completed' || ev.type === 'run.failed' || ev.type === 'run.suspended')
        ) {
          check();
        }
      });
      check();
    });
  }

  /**
   * Resume each run only if this instance can acquire its recovery lease — so when several
   * replicas recover or poll at once, each run is picked up by exactly one of them.
   */
  private async resumeLeased(
    runs: WorkflowRun[],
    nowMs: number = this.clock(),
    onLocked?: (run: WorkflowRun) => Promise<RunResult | undefined>,
  ): Promise<RunResult[]> {
    if (this.draining) return []; // shutting down — don't pick up new runs
    const results: RunResult[] = [];
    for (const run of runs) {
      const acquired = await this.store.tryLockRun(
        run.id,
        this.instanceId,
        nowMs + this.leaseMs,
        nowMs,
      );
      if (!acquired) continue;
      // A per-run hook (recovery counting / dead-lettering) may settle the run terminally instead.
      const settled = onLocked ? await onLocked(run) : undefined;
      results.push(settled ?? (await this.resume(run.id)));
    }
    return results;
  }

  /**
   * Deliver an external signal to the run waiting on `token` and resume it with `payload`.
   * Returns the run result, or null if no run is waiting for that token.
   */
  /**
   * Publish a named event. It does two things, and returns how many runs it touched (the sum):
   *  1. **Resumes** every in-flight run waiting on it via `ctx.waitForEvent(name, { match })` whose
   *     match the payload satisfies (fan-out, vs `signal`'s point-to-point token).
   *  2. **Starts** a fresh run of every workflow registered with `onEvent: [name]`, passing the
   *     payload as input. Idempotent by `evt:<id>:<workflow>` — pass `opts.id` to dedupe redeliveries
   *     of the same logical event (default: a fresh uuid, so each publish triggers once).
   *
   * Semantics (deliberate — mirrors `signalWithStart`'s reliability contract, so document it exactly):
   * a publish that resumes ≥1 live waiter, OR routes into an `eventBatch` accumulator / starts ≥1
   * subscriber, behaves exactly as above and is NOT buffered — fan-out stays live-only, same as
   * today. A publish that touches NEITHER — no live waiter matched, no subscriber exists/started —
   * buffers ONE copy (via {@link StateStore.bufferEvent}) unless `opts.buffer === false`, so it isn't
   * silently dropped just because nobody happened to be listening yet. That buffered copy is consumed
   * by the FIRST future `ctx.waitForEvent(name, { match })` whose match accepts its payload —
   * point-to-point on redelivery, by design (only one waiter ever gets it, even though the LIVE path
   * above is fan-out) — never by a second, later-registered onEvent subscriber (subscriber starts stay
   * live-only; `opts.id` dedupe applies to those only, unchanged). Right after buffering, this re-checks
   * `listSignalWaiters` ONCE — sandwich parity with `signal`'s own take → buffer → re-check — so a
   * waiter that registers in the sliver between the initial miss and the buffer write is still paired
   * instead of leaving both rows stranded (see `signal`'s interleaving proof; `waitForEvent`'s own
   * post-registration buffer scan is the mirror-image half of this same race).
   */
  async publishEvent(
    name: string,
    payload: unknown,
    opts?: { id?: string; buffer?: boolean },
  ): Promise<number> {
    let touched = 0;
    const waiters = await this.store.listSignalWaiters(eventPrefix(name));
    for (const w of waiters) {
      if (eventMatches(payload, eventMatchOf(w.token))) {
        await this.signal(w.token, payload);
        touched += 1;
      }
    }
    const subscribers = this.eventTriggers.get(name);
    if (subscribers?.size) {
      const eventId = opts?.id ?? globalThis.crypto.randomUUID();
      for (const workflow of subscribers) {
        // A subscriber that rejects the payload (validateInput) must not block the others or the
        // waiters — its run simply never starts, mirroring fire-and-forget dead-letter routing.
        try {
          const batch = this.latest.get(workflow)?.eventBatch;
          if (batch) {
            // Coalesce: route the event into a per-workflow accumulator (one long-lived run that
            // debounces/batches and then starts the target with the collected payload(s)).
            await this.accumulators.route(workflow, batch, payload);
          } else {
            await this.start(workflow, payload, `evt:${eventId}:${workflow}`);
          }
          touched += 1;
        } catch {
          // skip this subscriber
        }
      }
    }
    // Nobody received it live (no waiter matched, no subscriber exists/started) — buffer ONE copy
    // unless the caller opted out. `touched > 0` covers BOTH the waiter fan-out and the subscriber
    // loop above, matching the "no one received it" condition the semantics doc promises.
    if (touched > 0 || opts?.buffer === false) return touched;
    const bufferedId = globalThis.crypto.randomUUID();
    await this.store.bufferEvent({ name, payload, id: bufferedId, publishedAt: this.clock() });
    // Re-check: a waiter may have registered in the window between the miss above and this buffer
    // write (see the interleaving proof at `signal` — this is the events-side mirror of it). Only the
    // FIRST late-registered matching waiter is considered: only one buffered copy exists, so once a
    // claim attempt below either succeeds or finds the buffer already gone, there is nothing left for
    // any other candidate regardless.
    const lateWaiters = await this.store.listSignalWaiters(eventPrefix(name));
    const lateWaiter = lateWaiters.find((w) => eventMatches(payload, eventMatchOf(w.token)));
    if (!lateWaiter) return touched;
    if (!(await this.store.removeBufferedEvent(bufferedId))) return touched; // claimed elsewhere already
    // `takeSignalWaiter` is safe here even though it deletes ANY row for the token: an event token
    // embeds this ONE `waitForEvent` call's own `runId#seq` (see eventToken in events.ts), so no other
    // registration could ever share it.
    const waiter = await this.store.takeSignalWaiter(lateWaiter.token);
    if (waiter) {
      const settled = await this.deliverSignal(waiter, payload);
      if (settled) touched += 1;
    }
    // If `waiter` is null, that exact registration resolved itself some other way in the interim (most
    // likely its own timeout deadline landing in this same sliver) — the buffered copy is already
    // spent (claimed above), so — mirroring `signal`'s own reclaim precedent — drop it rather than
    // resuming a run a second time or re-buffering for a THIRD, unrelated waiter to pick up later.
    return touched;
  }

  /**
   * Deliver a signal to an already-known waiter: write its resolving `signal:<token>` checkpoint and
   * resume the run. Shared by {@link signal}'s direct hit, its post-buffer re-check reclaim, and the
   * due-timer reconcile sweep ({@link reconcileSignalWaiter}) — all three resolve a waiter the exact
   * same way.
   */
  private async deliverSignal(waiter: SignalWaiter, payload: unknown): Promise<RunResult | null> {
    await this.store.saveCheckpoint(
      instantCheckpoint({
        runId: waiter.runId,
        seq: waiter.seq,
        name: `signal:${waiter.token}`,
        kind: 'signal',
        output: payload,
        // Carry the awaiting command's fan group (set when a `ctx.gather_children`/`ctx.all` fan-out
        // registered this waiter) onto the resolving `signal:child:<id>` checkpoint, so the dashboard
        // groups the child fan-out vertically instead of rendering it as a sequential chain. Undefined
        // for an ordinary (non-fan) signal/child await.
        parallelGroup: waiter.parallelGroup,
      }),
    );
    return this.resume(waiter.runId).catch((err) => {
      if (err instanceof NamespaceMismatch) return null;
      throw err;
    });
  }

  /**
   * Deliver an external signal to the run waiting on `token`, resume it with `payload`, and return
   * the run result — or null if no run is (or ends up) waiting for it.
   *
   * Race with the waiter side (`waitForSignal`'s check → `putSignalWaiter` → re-check, same shape in
   * the remote `waitSignal` command): a waiter can register in the sliver between this method's
   * initial `takeSignalWaiter` miss and its `bufferSignal` write, and the naive old flow (buffer and
   * return) would then leave BOTH a buffered payload and a registered waiter sitting in the store with
   * nothing left to pair them — a lost wake, forever suspended.
   *
   * The interleaving proof: the waiter side does check → put → re-check, this side does take → buffer
   * → re-check. Whichever side's SECOND look runs last is guaranteed to observe the other side's
   * write, because it always follows that write in real time:
   *  - If the waiter's `put` lands before this method's first `take`, the take just finds it directly
   *    (the pre-existing, non-racy path).
   *  - If the waiter's `put` lands after this method's `bufferSignal`, our re-check below either sees
   *    it (if `put` also lands before the re-check) or the waiter's OWN post-put re-check sees our
   *    buffer (if `put` lands after our re-check but the waiter hasn't re-checked yet either — its
   *    re-check strictly follows its own put).
   *  - If the waiter's `put` lands between this method's `take` and its re-`take`, the re-check below
   *    catches it.
   * Either way, the destructive `take*` ops (on the waiter row, on the buffer) arbitrate: whichever
   * side actually removes the row is the one that delivers, so a signal is never delivered twice.
   */
  async signal(token: string, payload: unknown): Promise<RunResult | null> {
    const waiter = await this.store.takeSignalWaiter(token);
    if (waiter) return this.deliverSignal(waiter, payload);
    // No one was waiting yet — buffer it so the next `waitForSignal(token)` consumes it instead of
    // dropping it (reliable signals; the basis of `signalWithStart`).
    await this.store.bufferSignal(token, payload);
    // Re-check: a waiter may have registered in the window between the miss above and this buffer
    // write (see the interleaving proof above).
    const lateWaiter = await this.store.takeSignalWaiter(token);
    if (!lateWaiter) return null;
    const reclaimed = await this.store.takeBufferedSignal(token);
    if (!reclaimed) {
      // The waiter side won the race to consume the buffer itself (its own checkpoint+resume already
      // delivered the payload) in the sliver between our takeSignalWaiter and takeBufferedSignal just
      // above. We've already (destructively) taken `lateWaiter` off the store, but there is nothing
      // left to deliver — drop it deliberately rather than resuming the run a second time.
      return null;
    }
    return this.deliverSignal(lateWaiter, reclaimed.payload);
  }

  /**
   * Ensure a run exists for `runId`, then deliver a signal to it — atomically race-free thanks to
   * signal buffering: if the run is new (or busy / not yet waiting), the signal is buffered and
   * consumed when it reaches `waitForSignal(token)`. The canonical **durable-entity / accumulator**
   * pattern: one long-lived run per key (the `runId`) that loops on `waitForSignal`, fed events by
   * many `signalWithStart` calls. `start` is idempotent by `runId`, so concurrent callers converge on
   * one run. (Use a per-run `token`, e.g. derived from `runId`, so the signal targets this entity.)
   */
  async signalWithStart(
    workflow: WorkflowRef,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: StartOptions,
  ): Promise<{ runId: string }> {
    // `start` is overloaded per ref kind (class | string); a `WorkflowRef` union fits neither
    // overload, so resolve to the string overload (the engine handles both at runtime).
    await this.start(workflow as string, input, runId, opts); // idempotent: no-op if run exists
    await this.signal(signal.token, signal.payload);
    return { runId };
  }

  /**
   * Report the result of a `ctx.task(name, …)` back to its run (async completion). The external
   * worker that the task dispatched to calls this when done; the run resumes with `result`. Returns
   * null if no run is waiting on the task (e.g. a duplicate/late delivery) — a safe no-op.
   */
  async completeTask(runId: string, name: string, result: unknown): Promise<RunResult | null> {
    return this.signal(`task:${runId}:${name}`, {
      ok: true,
      value: result,
    } satisfies Completion<unknown>);
  }

  /** Report that a `ctx.task` failed — the run resumes and throws a FatalError at the task. */
  async failTask(runId: string, name: string, error: string): Promise<RunResult | null> {
    return this.signal(`task:${runId}:${name}`, { ok: false, error } satisfies Completion<never>);
  }

  /**
   * Notify a parent that's waiting on `runId` as a child of its terminal outcome (the `ctx.child`
   * rendezvous). A no-op when no parent is waiting, so `execute()` can call it on every run without
   * knowing about the child feature.
   */
  private notifyParent(runId: string, completion: Completion<unknown>): void {
    void this.signal(`child:${runId}`, completion).catch(() => undefined);
  }

  /**
   * Deferred child start shared by the in-process ctx host and the remote `startChild` command.
   * Deferred (microtask) so a fast child can't reentrantly resume a still-suspending parent. A start
   * that THROWS (unregistered/unroutable workflow, input validation, singleton back-pressure, store
   * failure) must NOT be swallowed: the parent is already suspended on `child:<childId>` (the waiter
   * is put BEFORE start on every path), so a silent drop parks it in suspended-forever, invisibly
   * re-attempting on every recovery wake — a misconfigured remote child looks exactly like a healthy
   * long wait. Instead the failure is delivered to that waiter like a failed child (notifyParent):
   * the parent resumes and fails loudly with the cause. For a fire-and-forget `ctx.startChild`
   * (spawn — no waiter) the completion is buffered; a later join by the same id consumes it and
   * correctly observes the failed start.
   */
  private startChildDeferred(
    workflow: string,
    input: unknown,
    childId: string,
    opts?: StartOptions,
  ): void {
    queueMicrotask(
      () =>
        void this.start(workflow, input, childId, opts).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.notifyParent(childId, {
            ok: false,
            error: `child workflow "${workflow}" failed to start: ${message}`,
          });
        }),
    );
  }

  /**
   * Cancel a run (e.g. from the dashboard). Returns null if the run does not exist. Pass
   * `{ compensate: true }` to undo the saga first: the suspended run is resumed so its completed
   * steps' compensations run in reverse (visible as `compensate:<step>` events), then it's marked
   * cancelled. Without it, cancellation is immediate (no undo).
   */
  async cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    // Already finished — nothing to cancel (and don't clobber a completed/dead run). This also stops
    // the child cascade below from looping on already-cancelled runs.
    if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'dead') {
      return { runId, status: run.status, output: run.output, error: run.error };
    }
    // Already compensating (status persisted as `cancelling`): idempotent — don't re-queue the resume,
    // and crucially don't fall through to the instant-cancel path below (which would mark `cancelled`
    // and SKIP the in-flight saga undo). A repeat cancel just echoes the in-progress status.
    if (run.status === 'cancelling') {
      return { runId, status: 'cancelling' };
    }
    // Compensating cancel: resume the run with a cancellation pending — replay re-registers the saga,
    // and at the suspension point execute() runs the undo and marks it cancelled. Run that resume in
    // the BACKGROUND so the caller (e.g. an HTTP request) never blocks on replaying the workflow +
    // compensations. `execute` holds the run's lease, so this can't double-run one a live worker owns
    // (its lease acquire fails and it no-ops); the broadcast tells that worker to abort cooperatively.
    if (opts?.compensate && (run.status === 'suspended' || run.status === 'running')) {
      this.cancelRequested.add(runId);
      // Persist `cancelling` so the dashboard/API show "compensation in progress" instead of a
      // misleading `running`/`suspended` while the background undo runs. NON-TERMINAL: the admission
      // gate still counts it and recovery re-drives it on crash (runExecution re-derives the cancel
      // intent from this status), so the cancel is durable; it flips to `cancelled` when the resumed
      // replay finishes compensating.
      await this.store.updateRun(runId, { status: 'cancelling', updatedAt: new Date() });
      run.status = 'cancelling';
      if (this.controlPlane) {
        void this.controlPlane
          .publishControl({ kind: 'cancel', runId, from: this.instanceId })
          .catch(() => undefined);
      }
      queueMicrotask(() => {
        void this.resume(runId)
          .then(() => this.notifyCancelled(runId))
          .catch(() => undefined);
      });
      await this.cancelChildren(runId, opts);
      return { runId, status: 'cancelling' };
    }
    const error = { message: 'cancelled' };
    await this.store.updateRun(runId, { status: 'cancelled', error, updatedAt: new Date() });
    this.emit({
      type: 'run.failed',
      runId,
      workflow: run.workflow,
      namespace: run.namespace,
      error,
    });
    await this.cancelChildren(runId, opts);
    // Notify local cancel listeners now (a worker on this pod), and broadcast so the instance/worker
    // actually running this run learns of it and can abort cooperatively (the store already records
    // `cancelled`, but a busy worker won't re-read it).
    this.notifyCancelled(runId);
    if (this.controlPlane) {
      void this.controlPlane
        .publishControl({ kind: 'cancel', runId, from: this.instanceId })
        .catch(() => undefined);
    }
    // A cancelled singleton run frees its slot — wake the next gated waiter now (notify-on-release).
    void this.singletons.wakeNext(run).catch(() => undefined);
    return { runId, status: 'cancelled', error };
  }

  /**
   * Bulk-cancel every run matching a filter — e.g. cancel all `order` runs tagged `vip`, or every run
   * whose `tier` search attribute is `free`. The filter is a {@link RunQuery} (workflow / status / tag
   * / search-attribute predicates), so it reuses the same matching the dashboard list uses. Each match
   * is run through {@link cancel}, so the same plumbing applies per run: child cascade, the optional
   * saga `compensate`, local cancel listeners, and the control-plane broadcast that tells the owning
   * worker to abort. Returns one {@link RunResult} per matched run (already-finished matches report
   * their terminal status — `cancel` is a no-op on them, never clobbering a completed/dead run).
   */
  async cancelWhere(
    filter: Omit<RunQuery, 'limit' | 'offset'>,
    opts?: { compensate?: boolean },
  ): Promise<RunResult[]> {
    const runs = await this.store.listRuns(filter);
    const results: RunResult[] = [];
    for (const run of runs) {
      const r = await this.cancel(run.id, opts);
      if (r) results.push(r);
    }
    return results;
  }

  /**
   * Hard-delete a run and its entire subtree. Unlike {@link cancel} (which marks a run `cancelled`
   * but keeps it as history), delete REMOVES the run and all its rows (checkpoints, signal waiters,
   * search-attribute rows) — it vanishes from {@link getRun} and {@link listRuns}. Use it to purge a
   * finished run whose data is being deleted (e.g. a pipeline run whose result rows are cleared).
   *
   * Cascades depth-first via {@link getRunChildren} so children are gone before the parent (no
   * orphaned child runs). Prefer {@link cancel} first for a live run — deleting one mid-flight orphans
   * its worker (its next checkpoint write fails). Returns the number of runs deleted (0 if absent).
   */
  async deleteRun(runId: string): Promise<number> {
    const run = await this.store.getRun(runId);
    if (!run) return 0;
    // Collect children BEFORE deleting this run's checkpoints (getRunChildren reads them).
    let deleted = 0;
    for (const childId of await this.getRunChildren(runId)) {
      deleted += await this.deleteRun(childId);
    }
    await this.store.deleteRun(runId);
    return deleted + 1;
  }

  /**
   * Cascade cancellation to a run's children — both awaited (`ctx.child`, found via its live
   * `child:<id>` waiter) and fire-and-forget (`ctx.startChild`, found via its `spawn:<id>`
   * checkpoint). Recursive, so a whole subtree is cancelled; the terminal guard in `cancel` stops it
   * at finished / already-cancelled runs (no loops, no re-cancel).
   */
  private async cancelChildren(
    parentRunId: string,
    opts?: { compensate?: boolean },
  ): Promise<void> {
    for (const id of await this.getRunChildren(parentRunId)) {
      await this.cancel(id, opts).catch(() => undefined);
    }
  }

  /**
   * The ids of the runs a run spawned — both awaited (`ctx.child`) and fire-and-forget
   * (`ctx.startChild`, found via its `spawn:<id>` checkpoint). The canonical parent→children edge,
   * used for both cancellation cascades and the dashboard run-tree.
   *
   * An awaited child is discovered two ways, because the live `child:<id>` waiter only exists WHILE
   * the parent is suspended on it: the waiter resolves and is consumed the moment the child settles,
   * so a completed parent (or a completed awaited child) would otherwise drop out of the tree. The
   * `signal:child:<id>` checkpoint (the placeholder written when the parent first awaits the child,
   * overwritten as completed/failed when it settles) persists across completion, so we read both and
   * dedupe — the edge stays stable for a finished run, not just a live one.
   */
  async getRunChildren(parentRunId: string): Promise<string[]> {
    const childIds = new Set<string>();
    for (const w of await this.store.listSignalWaiters('child:')) {
      if (w.runId === parentRunId) childIds.add(w.token.slice('child:'.length));
    }
    // Targeted read: only the `signal:child:` / `spawn:` checkpoints, not the whole history. Falls
    // back to a full listCheckpoints + in-JS prefix scan for a custom store that omits the method.
    const prefixes = ['signal:child:', 'spawn:'];
    const childCheckpoints = this.store.listCheckpointsByNamePrefix
      ? await this.store.listCheckpointsByNamePrefix(parentRunId, prefixes)
      : (await this.store.listCheckpoints(parentRunId)).filter((cp) =>
          prefixes.some((p) => cp.name.startsWith(p)),
        );
    for (const cp of childCheckpoints) {
      if (cp.name.startsWith('signal:child:')) childIds.add(cp.name.slice('signal:child:'.length));
      if (cp.name.startsWith('spawn:') && typeof cp.output === 'string') childIds.add(cp.output);
    }
    return [...childIds];
  }

  /** The worker groups this engine dispatches to: every registered remote workflow's group, plus any
   *  `extra` the caller declares. Local-step groups (a group consumed by in-process `@DurableStep`
   *  workers, e.g. `pipeline`) aren't derivable from registrations — pass them via `extra` so a group
   *  with backlog and ZERO workers is still reported (the alert case has no heartbeat to discover). */
  knownGroups(extra: string[] = []): string[] {
    const groups = new Set<string>(extra);
    for (const def of this.workflows.values()) {
      if (def.remote?.group) groups.add(def.remote.group);
    }
    return [...groups];
  }

  /** Per-group worker health (queue backlog + live worker heartbeats). Covers {@link knownGroups}
   *  (so a registered group with backlog and ZERO workers still reports — the alert case) UNION the
   *  groups discovered from live heartbeats (so a local-step group like `pipeline`, not derivable
   *  from registrations, shows once its workers beat). Empty when no transport can introspect health
   *  (only the BullMQ transport implements `groupHealth`). */
  async workerHealth(extra: string[] = []): Promise<GroupHealth[]> {
    const groups = new Set([...this.knownGroups(extra), ...(await this.pool.listWorkerGroups())]);
    // Classify each group workflow-vs-step from the registry (authoritative — no name heuristic): a
    // group whose base token is a registered workflow serves a `@Workflow` body; anything else (an
    // in-process `@Step`, a remote `handle_*` step) is a step. A LOCAL workflow's queue token is
    // `sanitizeQueueToken(name)`; a REMOTE one (e.g. Python) routes to its `remote.group`, which can
    // differ from the name — so seed the workflow-token set with BOTH.
    const workflowTokens = new Set<string>();
    for (const def of this.workflows.values()) {
      workflowTokens.add(sanitizeQueueToken(def.name));
      if (def.remote?.group) workflowTokens.add(def.remote.group);
    }
    const out: GroupHealth[] = [];
    for (const group of groups) {
      const health = await this.pool.groupHealth(group);
      if (!health) continue;
      const at = group.lastIndexOf('@');
      const baseToken = at === -1 ? group : group.slice(0, at);
      out.push({ ...health, kind: workflowTokens.has(baseToken) ? 'workflow' : 'step' });
    }
    return out;
  }

  /**
   * Persist a streamed local-step lifecycle event from a remote workflow worker (see
   * {@link WorkflowStepEvent}). A Python `@workflow` runs its `ctx.step`s inline over one turn that
   * can last minutes; the worker streams each step's start/finish so the engine checkpoints it LIVE —
   * a step shows `running` the moment its body begins, then resolves to `completed`/`failed` with its
   * real wall-clock window and sub-process events — instead of every step appearing at once when the
   * turn ends. The turn's final `recordStep` command re-persists the same (runId, seq) checkpoint
   * idempotently, so this is purely additive observability and never changes the run's outcome.
   */
  private async persistStepEvent(event: WorkflowStepEvent): Promise<void> {
    const startedAt = new Date(event.startedAt);
    if (event.phase === 'running') {
      await this.store.saveCheckpoint(
        stepCheckpoint({
          runId: event.runId,
          seq: event.seq,
          name: event.name,
          kind: 'local',
          status: 'running',
          events: event.events,
          attempts: 1,
          enqueuedAt: startedAt,
          startedAt,
          finishedAt: startedAt, // placeholder until the step settles
          parallelGroup: event.parallelGroup,
        }),
      );
      this.emit({
        type: 'step.started',
        runId: event.runId,
        seq: event.seq,
        name: event.name,
        kind: 'local',
      });
      return;
    }
    const failed = event.phase === 'failed';
    await this.store.saveCheckpoint(
      stepCheckpoint({
        runId: event.runId,
        seq: event.seq,
        name: event.name,
        kind: 'local',
        status: failed ? 'failed' : 'completed',
        output: failed ? undefined : event.output,
        error: failed ? event.error : undefined,
        events: event.events,
        attempts: 1,
        enqueuedAt: startedAt,
        startedAt,
        finishedAt: event.finishedAt != null ? new Date(event.finishedAt) : new Date(),
        parallelGroup: event.parallelGroup,
      }),
    );
    this.emit({
      type: failed ? 'step.failed' : 'step.completed',
      runId: event.runId,
      seq: event.seq,
      name: event.name,
      kind: 'local',
      output: failed ? undefined : event.output,
      error: failed ? event.error : undefined,
    });
  }

  /**
   * Announce a local step's body has begun and (when `trackStepStart`) checkpoint it as `running`,
   * so it's visible in flight rather than appearing only on completion. The checkpoint is a
   * placeholder overwritten by {@link completeStep}/{@link failStep}; it never short-circuits replay
   * (only `completed` does), so a crash mid-body just re-runs the step. The `step.started` event
   * fires regardless — the live SSE view sees the start even with persistence off.
   */
  private async startStep(step: StepRecord): Promise<void> {
    if (this.trackStepStart) {
      await this.store.saveCheckpoint(
        stepCheckpoint({
          runId: step.runId,
          seq: step.seq,
          name: step.name,
          kind: step.kind,
          status: 'running',
          input: step.input,
          events: step.events,
          attempts: step.attempts,
          workerGroup: step.workerGroup,
          enqueuedAt: step.enqueuedAt,
          startedAt: step.startedAt,
          finishedAt: step.startedAt, // placeholder until the body settles
        }),
      );
    }
    this.emit({
      type: 'step.started',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
    });
  }

  /** Checkpoint a finished step and announce it — the two things that must always happen together. */
  private async completeStep(step: StepRecord & { output: unknown }): Promise<void> {
    await this.store.saveCheckpoint(
      stepCheckpoint({
        runId: step.runId,
        seq: step.seq,
        name: step.name,
        kind: step.kind,
        status: 'completed',
        input: step.input,
        output: step.output,
        events: step.events,
        attempts: step.attempts,
        workerGroup: step.workerGroup,
        enqueuedAt: step.enqueuedAt,
        startedAt: step.startedAt,
        finishedAt: new Date(),
      }),
    );
    this.emit({
      type: 'step.completed',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      output: step.output,
      queueMs: step.startedAt.getTime() - step.enqueuedAt.getTime(),
      durationMs: Date.now() - step.startedAt.getTime(),
    });
  }

  /** Checkpoint a step that failed terminally, so the failure point is visible (not just the run). */
  private async failStep(step: StepRecord & { error: StepError }): Promise<void> {
    await this.store.saveCheckpoint(
      stepCheckpoint({
        runId: step.runId,
        seq: step.seq,
        name: step.name,
        kind: step.kind,
        status: 'failed',
        input: step.input,
        error: step.error,
        events: step.events,
        attempts: step.attempts,
        workerGroup: step.workerGroup,
        enqueuedAt: step.enqueuedAt,
        startedAt: step.startedAt,
        finishedAt: new Date(),
      }),
    );
    this.emit({
      type: 'step.failed',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      error: step.error,
      queueMs: step.startedAt.getTime() - step.enqueuedAt.getTime(),
      durationMs: Date.now() - step.startedAt.getTime(),
    });
  }

  private async execute(run: WorkflowRun, fn: WorkflowFn): Promise<RunResult> {
    // Synchronous fast path (`??` short-circuits) for registered runs — no extra await, so execution
    // timing for the common case is unchanged; only an unregistered (inherited-remote) run awaits.
    const registered =
      this.workflows.get(versionKey(run.workflow, run.workflowVersion)) ??
      (await this.findInheritedRegistration(run)) ??
      (await this.resolveRemoteByConvention(run));
    // Hold the lease for the WHOLE execution — whatever path got us here (leased sweep, a signal, a
    // remote result, a dashboard action). The leased sweeps already own it; the event-driven paths
    // don't, so acquire it here. If another instance owns it, don't double-run. While we run, renew
    // the lease periodically so a long run keeps it (a crashed worker's lease still expires and is
    // reclaimed by periodic recovery).
    const lockNow = this.clock();
    if (run.lockedBy !== this.instanceId || (run.lockedUntil ?? 0) <= lockNow) {
      if (
        !(await this.store.tryLockRun(run.id, this.instanceId, lockNow + this.leaseMs, lockNow))
      ) {
        return { runId: run.id, status: run.status };
      }
    }
    const renew = setInterval(
      () => {
        void this.store
          .renewRunLock(run.id, this.instanceId, this.clock() + this.leaseMs)
          .catch(() => undefined);
      },
      Math.max(50, Math.floor(this.leaseMs / 2)),
    );
    renew.unref?.();
    try {
      // A remote (e.g. Python) workflow is advanced by dispatching workflow tasks, not by running an
      // in-process body — but everything around it (lease, recovery, timers, the resume that lands us
      // here on a step result) is identical, so it branches here under the same lease.
      const result = registered?.remote
        ? await this.runRemoteExecution(run, registered)
        : await this.runExecution(run, fn, registered);
      // Notify-on-release: a singleton run that just reached a terminal state freed a slot — wake the
      // next gated waiter(s) now instead of waiting for the ~1s retry timer. Fire-and-forget so it
      // never blocks the settling run; the durable timer is still the cross-instance/crash fallback.
      if (
        registered?.singleton &&
        (result.status === 'completed' ||
          result.status === 'failed' ||
          result.status === 'cancelled' ||
          result.status === 'dead')
      ) {
        void this.singletons.wakeNext(run).catch(() => undefined);
      }
      return result;
    } finally {
      clearInterval(renew);
    }
  }

  /**
   * Advance a remote (cross-SDK) workflow one turn: hand its history to the executor (which dispatches
   * a workflow task to the worker and awaits its replay) and apply the decision. Mirrors
   * {@link runExecution}'s settle/suspend; the lease is held by {@link execute}. The result that lands
   * us back here (a remote step finished, a timer fired) goes through `resume` like any TS workflow.
   */
  /**
   * Apply a terminal/suspended transition once: persist the new run status, emit the matching
   * lifecycle event, and (on completion/failure) wake a waiting parent. Both the TS and remote
   * executors funnel their completed/failed/suspended outcomes through here so a status update can
   * never drift from its event or `notifyParent` call. Does NOT touch the run lock — each executor
   * keeps its own lease handling (the TS executor's `finally`, the remote path's caller).
   */
  private async settleRun(run: WorkflowRun, outcome: RunOutcome): Promise<RunResult> {
    const updatedAt = new Date();
    if (outcome.kind === 'completed') {
      // Clear any error from an earlier failed-then-retried attempt — a completed run is a success.
      await this.store.updateRun(run.id, {
        status: 'completed',
        output: outcome.output,
        error: undefined,
        updatedAt,
      });
      this.emit({
        type: 'run.completed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        output: outcome.output,
      });
      void this.notifyParent(run.id, { ok: true, value: outcome.output });
      return { runId: run.id, status: 'completed', output: outcome.output };
    }
    if (outcome.kind === 'failed') {
      await this.store.updateRun(run.id, { status: 'failed', error: outcome.error, updatedAt });
      this.emit({
        type: 'run.failed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        error: outcome.error,
      });
      void this.notifyParent(run.id, { ok: false, error: outcome.error.message });
      return { runId: run.id, status: 'failed', error: outcome.error };
    }
    // This outcome was computed by a turn that started from a possibly-stale run snapshot. If the run
    // was cancelled WHILE that turn was still executing (e.g. `ctx.all`'s failFast cancelling a
    // sibling mid-turn — plain `cancel()` writes `cancelled` directly, without waiting for the target's
    // in-flight turn to notice), this now-stale "suspended" outcome must not resurrect it: re-check the
    // CURRENT persisted status right before writing and echo it instead of clobbering a real cancel.
    const latest = await this.store.getRun(run.id);
    if (latest?.status === 'cancelled') {
      return { runId: run.id, status: 'cancelled', error: latest.error };
    }
    await this.store.updateRun(run.id, {
      status: 'suspended',
      wakeAt: this.reconcileWakeAt(outcome.wakeAt),
      updatedAt,
    });
    this.emit({
      type: 'run.suspended',
      runId: run.id,
      workflow: run.workflow,
      namespace: run.namespace,
    });
    return { runId: run.id, status: 'suspended' };
  }

  /**
   * A wakeAt to persist on a suspend: the natural timer if the turn produced one (a `ctx.sleep`, a
   * remote-step deadline), else the {@link reconcileMs} fallback so an event-waiting run (child/signal/
   * timeout-less remote step) can't be orphaned forever if its wake is lost. `undefined` only when the
   * fallback is disabled (`reconcileMs: 0`). See {@link WorkflowEngineDeps.reconcileMs}.
   */
  private reconcileWakeAt(wakeAt: number | undefined): number | undefined {
    if (wakeAt != null) return wakeAt;
    return this.reconcileMs != null ? this.clock() + this.reconcileMs : undefined;
  }

  private async runRemoteExecution(
    run: WorkflowRun,
    registered: RegisteredWorkflow,
  ): Promise<RunResult> {
    // Compensating cancel in flight for a remote workflow: its steps execute in the worker, so there
    // are no TS-side compensations to replay here — finalize to cancelled. Re-broadcast so a live worker
    // mid-turn aborts cooperatively; on recovery (the broadcast was lost to a crash) this still settles
    // the run deterministically instead of resurrecting it by re-advancing.
    if (run.status === 'cancelling') {
      const error = { message: 'cancelled' };
      await this.store.updateRun(run.id, { status: 'cancelled', error, updatedAt: new Date() });
      this.emit({
        type: 'run.failed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        error,
      });
      this.notifyCancelled(run.id);
      if (this.controlPlane) {
        void this.controlPlane
          .publishControl({ kind: 'cancel', runId: run.id, from: this.instanceId })
          .catch(() => undefined);
      }
      await this.store.releaseRunLock(run.id);
      return { runId: run.id, status: 'cancelled', error };
    }
    const remote = registered.remote as NonNullable<RegisteredWorkflow['remote']>;
    if (run.status === 'pending') {
      await this.store.updateRun(run.id, { status: 'running', updatedAt: new Date() });
      run.status = 'running';
      this.emit({
        type: 'run.started',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
    }
    if (registered.singleton && !(await this.singletons.admit(run, registered.singleton))) {
      const wakeAt = this.singletons.retryWakeAt();
      await this.store.updateRun(run.id, { status: 'suspended', wakeAt, updatedAt: new Date() });
      this.emit({
        type: 'run.suspended',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
      await this.store.releaseRunLock(run.id);
      return { runId: run.id, status: 'suspended' };
    }

    const history = await this.remoteHistory(run.id);

    // DISPATCH-AND-SUSPEND (broker-backed executors): SUSPEND-then-ENQUEUE. The engine generates the
    // turn's `taskId`, records it on the run as the awaited marker, and RELEASES the lease — all BEFORE
    // enqueuing the turn — so a fast worker's decision (delivered over `onDecision`, applied durably by
    // `completeRemoteDecision` on WHATEVER instance consumes it) can NEVER arrive ahead of its marker,
    // nor contend with a still-held lease, and be dropped. (The original dispatch-then-mark order lost a
    // sub-millisecond cached-replay decision that round-tripped the in-cluster broker before the marker
    // write to the remote store committed — the multi-instance decision-drop's deeper race.) Liveness is
    // the suspended turn's heartbeat-rearmed window (`remoteAdvanceSilenceMs` → `wakeAt`): if no
    // decision/heartbeat lands before it lapses (including a dispatch that throws below), the timer
    // poller re-drives by re-marking + re-enqueuing a fresh turn.
    if (remote.executor.dispatch) {
      const taskId = `${run.id}:wf:${globalThis.crypto.randomUUID().slice(0, 8)}`;
      const silenceMs = this.remoteAdvanceSilenceMs;
      const wakeAt = silenceMs != null ? this.clock() + silenceMs : undefined;
      // MARK FIRST: record the awaited turn before it is enqueued. No resurrection risk — unlike the old
      // mark-AFTER-dispatch order, nothing rewrites `status` past this point, so a parent-cancel that
      // writes a terminal status during the enqueue below simply wins (its decision is later dropped by
      // `completeRemoteDecision`'s terminal-status check).
      await this.store.updateRun(run.id, {
        status: 'suspended',
        awaitingDecisionTaskId: taskId,
        wakeAt,
        updatedAt: new Date(),
      });
      this.emit({
        type: 'run.suspended',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
      // RELEASE BEFORE ENQUEUE: the decision must be able to BOTH match the marker AND acquire the lease
      // the instant it arrives — even a few ms after the enqueue. Holding the lease through the enqueue
      // would drop a fast decision at lock contention. Idempotent vs. `execute`'s own finally release.
      await this.store.releaseRunLock(run.id);
      // THEN enqueue. A failed/lost dispatch leaves the run suspended-awaiting with `wakeAt` set, so the
      // timer poller re-drives it — no lost run.
      await remote.executor.dispatch(run, history, taskId);
      return { runId: run.id, status: 'suspended' };
    }

    // INLINE advance (in-process group-served executors): the decision is produced in-process, so await
    // it under the lease. Single-instance by nature; the dispatch path above is the multi-instance one.
    const advanceExecutor = remote.executor.advance;
    if (!advanceExecutor) {
      throw new Error(
        `workflow ${run.workflow}@${run.workflowVersion}: executor implements neither advance nor dispatch`,
      );
    }
    let decision: WorkflowDecision;
    try {
      // When `remoteAdvanceSilenceMs` is configured, wrap the advance in a heartbeat-rearmed deadline
      // keyed by `run.id`: a worker replaying this turn beats (a run-scoped Heartbeat) to keep it alive,
      // and only a genuinely-silent worker trips RemoteWorkflowTimeout → recovery re-drive. Unset = the
      // prior unbounded await. INVARIANT: `advance()` is created and passed to awaitWithLivenessDeadline
      // SYNCHRONOUSLY (no await between), so the `heartbeatResets` entry is registered before the event
      // loop can deliver any beat — an early beat is never lost. If the executor ALSO carries its own
      // `timeoutMs`, the shorter of the two deadlines wins (both raise the same RemoteWorkflowTimeout,
      // handled identically by the catch below).
      const silenceMs = this.remoteAdvanceSilenceMs;
      const advance = advanceExecutor.call(remote.executor, run, history);
      decision =
        silenceMs != null
          ? await this.awaitWithLivenessDeadline(
              run.id,
              advance,
              silenceMs,
              () => new RemoteWorkflowTimeout(run.id, silenceMs),
            )
          : await advance;
    } catch (err) {
      // A RemoteWorkflowTimeout is NOT a failure: the advance only timed out (the decision was likely
      // dropped, while the work may have actually completed). Failing the run here would be wrong — and
      // would notify the parent of a false failure. Instead RELEASE the lease and leave the run in its
      // current `running` state so `recoverIncomplete` re-acquires the now-free lease and re-drives it;
      // the re-driven turn replays completed steps from history and, if the work was done, returns the same
      // `completed` decision → settles → notifies the parent. Opt-in: only reachable when the executor
      // was constructed with a `timeoutMs` (absent = prior unbounded await, unchanged).
      //
      // FIXED-TIMEOUT HAZARD: a bare RemoteWorkflowExecutor `timeoutMs` that fires while a worker is
      // LEGITIMATELY still executing a not-yet-checkpointed step re-drives → DUPLICATE side effects, so
      // that knob is only safe set GENEROUSLY (> the longest legitimate single turn). The robust fix is
      // the heartbeat-rearmed deadline above (`remoteAdvanceSilenceMs`): the worker beats while it works,
      // so only a genuinely-silent (dead) worker trips the timeout — no re-drive of a live turn.
      //
      // Lease lifecycle: `execute` clears its renew interval in its `finally` once this returns, so the
      // lease (released just below) stays free. `releaseRunLock` is idempotent, and `renewRunLock` is a
      // no-op once `lockedBy` is cleared, so a renew tick racing the release cannot re-acquire it.
      if (err instanceof RemoteWorkflowTimeout) {
        await this.store.releaseRunLock(run.id);
        // The suspended path returned early above; run is always `running` here — left for recovery to re-drive.
        return { runId: run.id, status: 'running' as const };
      }
      const error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      // terminal failure: lease expires naturally — no recovery re-drive will race it
      await this.store.updateRun(run.id, { status: 'failed', error, updatedAt: new Date() });
      this.emit({
        type: 'run.failed',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
        error,
      });
      return { runId: run.id, status: 'failed', error };
    }

    return this.applyDecision(run, decision);
  }

  /**
   * Apply a remote workflow turn's {@link WorkflowDecision}: persist the local steps it ran, then
   * settle (completed/failed/cancelled) or dispatch its blocking ops and suspend (continue). Shared by
   * the INLINE-advance path ({@link runRemoteExecution}, under the held lease) and the durable
   * DISPATCH path ({@link completeRemoteDecision}, which holds the lease itself). Idempotent transitions
   * — the caller has already ensured this is the decision for the currently-awaited turn.
   */
  private async applyDecision(run: WorkflowRun, decision: WorkflowDecision): Promise<RunResult> {
    if (decision.status === 'completed') {
      // Persist the local steps THIS turn ran before marking the run done. A workflow that runs
      // straight to completion in a single turn (every step inline, never suspending — e.g. a Python
      // @workflow whose body is a sequence of ctx.step calls) emits ALL its recordStep commands on
      // this terminal turn; without applying them the run shows `completed` with zero recorded steps.
      // Only this turn's NEW steps are present (prior turns' steps replay as `found`, emitting no
      // command), so there's no duplication.
      await this.applyCommands(run, decision.commands);
      return this.settleRun(run, { kind: 'completed', output: decision.output });
    }
    if (decision.status === 'failed') {
      // Same as completed: persist the steps this turn ran — including the failed one (the worker
      // records a failed-step command before raising) — so the dashboard shows WHERE it failed.
      await this.applyCommands(run, decision.commands);
      return this.settleRun(run, {
        kind: 'failed',
        error: decision.error ?? { message: 'workflow failed' },
      });
    }

    if (decision.status === 'cancelled') {
      // The worker bailed at an op boundary because the run was cancelled mid-turn — `cancel` already
      // set status=cancelled, cascaded to children and emitted the lifecycle event. Persist the steps
      // that DID run this turn (partial progress / where it stopped) and reassert `cancelled`
      // (idempotent with `cancel`'s write; preserves the existing error). The point is to NOT resurrect
      // the run to `suspended` or flip it to `failed` — both of which a normal turn result would do.
      await this.applyCommands(run, decision.commands);
      await this.store.updateRun(run.id, { status: 'cancelled', updatedAt: new Date() });
      return { runId: run.id, status: 'cancelled' };
    }

    // continue: persist any local steps the replay ran, dispatch the blocking ops, then suspend. When
    // those resolve (a result lands, a timer fires) `resume` brings us back for the next turn.
    //
    // Guard: re-read the run BEFORE writing `suspended` — a parent-cancel cascade may have written
    // `cancelled` to the store WHILE the executor was replaying this turn (the advance() awaited above
    // runs outside the store transaction). Overwriting `cancelled` → `suspended` would let recovery
    // re-drive the run forever. If the store already shows a terminal/cancelled state, bail without
    // touching it — identical to the guard in `completeRemoteResult` for remote step results.
    const fresh = await this.store.getRun(run.id);
    if (
      fresh &&
      (fresh.status === 'cancelled' || fresh.status === 'completed' || fresh.status === 'dead')
    ) {
      return { runId: run.id, status: fresh.status, output: fresh.output, error: fresh.error };
    }
    const wakeAt = await this.applyCommands(run, decision.commands);
    return this.settleRun(run, { kind: 'suspended', wakeAt });
  }

  /** The run's resolved durable ops as replay inputs: completed/failed steps + elapsed timers. */
  private async remoteHistory(runId: string): Promise<HistoryEvent[]> {
    const checkpoints = await this.store.listCheckpoints(runId);
    const kindOf: Record<StepKind, HistoryEvent['kind']> = {
      remote: 'call',
      local: 'step',
      sleep: 'timer',
      signal: 'signal',
    };
    const events: HistoryEvent[] = [];
    for (const cp of checkpoints) {
      if (cp.status === 'completed' || cp.status === 'failed') {
        // A child run resolves THROUGH the signal machinery (a `child:<id>` waiter notified on the
        // child's terminal state), so its checkpoint is kind `signal` with a `signal:child:` name and
        // a Completion payload. Surface it as a `child` event with the value/error unwrapped.
        if (cp.kind === 'signal' && cp.name.startsWith('signal:child:')) {
          const completion = cp.output as Completion<unknown> | undefined;
          events.push({
            seq: cp.seq,
            kind: 'child',
            output: completion?.ok ? completion.value : undefined,
            error:
              completion && completion.ok === false ? { message: completion.error } : undefined,
          });
          continue;
        }
        events.push({
          seq: cp.seq,
          kind: kindOf[cp.kind] ?? 'step',
          // A signal checkpoint's name is the internal `signal:<token>`, not the workflow-level signal
          // name the replay used — omit it so the replay matches on seq + kind (its determinism anchor).
          name: cp.kind === 'signal' ? undefined : cp.name,
          output: cp.status === 'completed' ? cp.output : undefined,
          error: cp.status === 'failed' ? cp.error : undefined,
        });
      } else if (cp.kind === 'sleep' && cp.wakeAt != null && cp.wakeAt <= this.clock()) {
        // a still-`pending` sleep whose deadline has passed reads as a resolved timer on replay.
        events.push({ seq: cp.seq, kind: 'timer', name: cp.name });
      }
    }
    return events.sort((a, b) => a.seq - b.seq);
  }

  /** Apply a turn's commands: persist recorded local steps, dispatch remote calls, schedule timers.
   *  Returns the earliest timer deadline to suspend on (or undefined — suspended on a result). */
  private async applyCommands(
    run: WorkflowRun,
    commands: WorkflowCommand[],
  ): Promise<number | undefined> {
    let wakeAt: number | undefined;
    for (const cmd of commands) {
      const at = new Date();
      const id = stepId(run.id, cmd.seq);
      if (cmd.kind === 'recordStep') {
        // Prefer the step's real wall-clock window + sub-process events (carried by the command, and
        // already streamed live via persistStepEvent) so the checkpoint shows a true duration and its
        // p-process trail — not a 0ms placeholder. Fall back to apply-time for older workers.
        const startedAt = cmd.startedAt != null ? new Date(cmd.startedAt) : at;
        const finishedAt = cmd.finishedAt != null ? new Date(cmd.finishedAt) : at;
        await this.store.saveCheckpoint(
          stepCheckpoint({
            runId: run.id,
            seq: cmd.seq,
            name: cmd.name,
            kind: 'local',
            status: cmd.error ? 'failed' : 'completed',
            output: cmd.output,
            error: cmd.error,
            events: cmd.events,
            attempts: 1,
            enqueuedAt: startedAt,
            startedAt,
            finishedAt,
            // Carry the worker's `parallelGroup` (a Python `ctx.gather` tags every step in the fan with
            // the same group) onto the checkpoint, so the dashboard can render the steps as one parallel
            // group instead of a sequential list. Additive: undefined for ordinary sequential steps.
            parallelGroup: cmd.parallelGroup,
          }),
        );
        this.emit({
          type: cmd.error ? 'step.failed' : 'step.completed',
          runId: run.id,
          seq: cmd.seq,
          name: cmd.name,
          kind: 'local',
          output: cmd.output,
          error: cmd.error,
        });
      } else if (cmd.kind === 'call') {
        // Idempotency (load-bearing for `ctx.gather_calls`): a fan-out re-emits its still-pending
        // `call` commands on every PARTIAL resume (a sibling settled, but not all). Without this guard
        // each re-emit would re-persist + re-dispatch an already-in-flight (or already-completed) step,
        // double-dispatching the worker and resetting attempts. So if a checkpoint for (run.id, seq)
        // already exists — pending OR terminal — skip the save + dispatch entirely; its result lands
        // independently via completeRemoteResult (keyed by seq, so concurrent calls never clobber).
        // Mirrors the `startChild` `getRun(childId)` guard below.
        if (await this.store.getCheckpoint(run.id, cmd.seq)) continue;
        await this.store.saveCheckpoint(
          stepCheckpoint({
            runId: run.id,
            seq: cmd.seq,
            name: cmd.name,
            kind: 'remote',
            status: 'pending',
            input: cmd.input,
            attempts: 1,
            // `cmd.group` is the routing declaration the worker's replay emitted (cross-SDK, or a
            // group-served TS body) — treated as an isolation partition on top of the step's own
            // name, mirroring the StepDef formula below (identical expression everywhere).
            workerGroup: tenantGroup(sanitizeQueueToken(cmd.name), cmd.group),
            enqueuedAt: at,
            startedAt: at,
            finishedAt: at,
            // A `ctx.gather_calls([...])` fan-out stamps every dispatched `call` in the fan with the
            // same group, so the dashboard renders the dispatched steps as one parallel fan (parity
            // with the gathered `recordStep`/`startChild` tags). Undefined for a lone sequential `ctx.step`.
            parallelGroup: cmd.parallelGroup,
          }),
        );
        await this.pool.dispatch(
          {
            runId: run.id,
            seq: cmd.seq,
            name: cmd.name,
            stepId: id,
            group: tenantGroup(sanitizeQueueToken(cmd.name), cmd.group),
            input: cmd.input,
            traceparent: this.traceparent?.(),
            context: this.context?.(),
            attempt: 1,
          },
          undefined,
        );
        this.emit({
          type: 'step.started',
          runId: run.id,
          seq: cmd.seq,
          name: cmd.name,
          kind: 'remote',
        });
      } else if (cmd.kind === 'sleep') {
        const deadline = this.clock() + cmd.ms;
        await this.store.saveCheckpoint(
          stepCheckpoint({
            runId: run.id,
            seq: cmd.seq,
            name: `sleep:${cmd.seq}`,
            kind: 'sleep',
            status: 'pending',
            attempts: 1,
            wakeAt: deadline,
            enqueuedAt: at,
            startedAt: at,
            finishedAt: at,
          }),
        );
        wakeAt = wakeAt == null ? deadline : Math.min(wakeAt, deadline);
      } else if (cmd.kind === 'waitSignal') {
        // Park on a signal: register a waiter at this seq so engine.signal(token) lands the resolving
        // `signal` checkpoint here and resumes the run. The token is the signal name, so an external
        // engine.signal(name, payload) delivers it. If the signal was already delivered (buffered
        // before the workflow reached this point — e.g. signalWithStart), resolve it now and re-drive
        // on a macrotask, AFTER this turn suspends and frees the run lock (a re-entrant resume bails).
        //
        // NOTE: `WorkflowCommand` has no `waitEvent` kind — a polyglot (remote-executor) workflow has
        // no way to issue `ctx.waitForEvent(name, { match })` today; only in-process TS workflows
        // (`workflow-ctx.ts`) can. So buffered EVENTS (`bufferEvent`/`listBufferedEvents`/
        // `removeBufferedEvent`) are reachable only from `engine.publishEvent` and the in-process
        // `waitForEvent`/reconcile paths — never from this remote command loop. Extending the
        // polyglot protocol with an event-wait command is future work, not something to invent here.
        const deliverBuffered = async (payload: unknown): Promise<void> => {
          await this.store.saveCheckpoint(
            instantCheckpoint({
              runId: run.id,
              seq: cmd.seq,
              name: `signal:${cmd.signal}`,
              kind: 'signal',
              output: payload,
            }),
          );
          setTimeout(() => void this.resume(run.id).catch(() => undefined), 0);
        };
        const buffered = await this.store.takeBufferedSignal(cmd.signal);
        if (buffered) {
          await deliverBuffered(buffered.payload);
        } else {
          // Same reorder as the in-process ctx.waitForSignal (see there for why registering
          // UNCONDITIONALLY before even the first check is unsafe — it would expose a "this turn is
          // about to self-resolve" waiter row to a concurrent signal for a token a polyglot entity
          // loop reuses, which could steal it and misdeliver): check first, and only on a miss
          // register, then re-check once more before suspending — closing the lost-wake window where
          // a signal races in between the miss above and the registration below (see the interleaving
          // proof at engine.signal).
          await this.store.putSignalWaiter({ token: cmd.signal, runId: run.id, seq: cmd.seq });
          const lateBuffered = await this.store.takeBufferedSignal(cmd.signal);
          if (lateBuffered) {
            // Resolved it ourselves — remove OUR OWN row via the exact match (not
            // takeSignalWaiter(cmd.signal), which deletes ANY row for this token and could steal a
            // different run's waiter that has since claimed the same token).
            await this.store.removeSignalWaiter({ token: cmd.signal, runId: run.id, seq: cmd.seq });
            await deliverBuffered(lateBuffered.payload);
          }
        }
      } else if (cmd.kind === 'startChild') {
        // Start a child run and await it (the worker's ctx.start_child suspends until the child's
        // result is in history). Mirror the in-process `ctx.child`: register a `child:<id>` waiter at
        // this seq — the child notifies it on its terminal state (engine.notifyParent) — then start the
        // child once, deferred so a fast child can't reentrantly resume this still-suspending parent,
        // and id-idempotent so replay/recovery never double-starts it.
        const childId = `${run.id}.child.${cmd.seq}`;
        await this.store.putSignalWaiter({
          token: `child:${childId}`,
          runId: run.id,
          seq: cmd.seq,
          // A `ctx.gather_children`/`ctx.all` fan-out stamps every `startChild` in the fan with the same
          // group. Thread it onto the waiter so the child's terminal `signal:child:<id>` checkpoint
          // (written by engine.signal when the child notifies the parent) carries the group and the
          // dashboard renders the fan as one parallel group. Undefined for a lone (non-fan) child.
          parallelGroup: cmd.parallelGroup,
        });
        if (!(await this.store.getRun(childId))) {
          // Inherit the parent run's namespace (see ctxHostFor.startChild) so a remote workflow's
          // child stays on the parent's tenant/partition regardless of which engine executes it.
          this.startChildDeferred(cmd.workflow, cmd.input, childId, { namespace: run.namespace });
        }
      } else {
        throw new Error(
          `remote workflow command '${(cmd as { kind: string }).kind}' is not supported yet`,
        );
      }
    }
    return wakeAt;
  }

  /**
   * Undo the registered saga compensations in reverse and settle the run `cancelled`. Shared by EVERY
   * exit path of a run with a compensating cancel in flight — whether the resumed replay returned,
   * suspended, hit continue-as-new, or threw — so a cancel is never lost just because the body didn't
   * stop at a suspension point.
   *
   * A dispatched compensation still in flight (or backing off a retry) needs the run to keep waiting:
   * unlike the failure path (which is fine going `suspended` — a resumable state no different from an
   * ordinary in-flight `ctx.step`), THIS run must stay `cancelling` — `engine.cancel`'s idempotent
   * re-check, `waitForRun`'s non-terminal treatment, and crash recovery (`recoverIncomplete` only
   * re-drives `running`/`cancelling` runs — a `cancelling` one with a free lease, whatever it's
   * internally waiting on) all key off that status. So on a pending unwind this returns WITHOUT
   * touching `status` (already `cancelling`, untouched since `engine.cancel` set it) — the in-memory
   * cancel flag stays too, re-derived from the status on any later re-drive regardless.
   */
  private async compensateAndCancel(
    run: WorkflowRun,
    compensations: Compensation[],
    replay?: Map<number, StepCheckpoint>,
  ): Promise<RunResult> {
    const pending = await this.unwindCompensations(run, compensations, replay);
    if (pending) return { runId: run.id, status: 'cancelling' };
    this.cancelRequested.delete(run.id);
    const error = { message: 'cancelled' };
    await this.store.updateRun(run.id, { status: 'cancelled', error, updatedAt: new Date() });
    this.emit({
      type: 'run.failed',
      runId: run.id,
      workflow: run.workflow,
      namespace: run.namespace,
      error,
    });
    return { runId: run.id, status: 'cancelled', error };
  }

  /** The run body, lease held + renewed by {@link execute}. */
  private async runExecution(
    run: WorkflowRun,
    fn: WorkflowFn,
    registered: RegisteredWorkflow | undefined,
  ): Promise<RunResult> {
    // A run persisted as `cancelling` is a compensating cancel in flight — possibly re-driven by
    // recovery after a crash that lost the in-memory cancel flag. Re-derive the intent from the status
    // so the replay below reaches the WorkflowSuspended + cancelRequested branch and compensates →
    // cancelled (this is what makes a compensating cancel durable across a crash).
    if (run.status === 'cancelling') this.cancelRequested.add(run.id);
    // First execution of an enqueued run: mark it running and announce the start, BEFORE the singleton
    // gate — `singletons.admit` only counts `running`/`suspended` runs, so a still-`pending` run could
    // never be admitted. A resumed run is already past `pending`, so this fires exactly once.
    if (run.status === 'pending') {
      await this.store.updateRun(run.id, { status: 'running', updatedAt: new Date() });
      run.status = 'running';
      this.emit({
        type: 'run.started',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
    }
    // Singleton admission gate: if this run shares its key with `limit` older in-flight runs, wait
    // (suspend on a short timer) until a slot frees instead of running now. Re-checked on each resume.
    // A `cancelling` run skips the gate — it is tearing down, not competing for a slot, and suspending
    // it here would clobber the `cancelling` status.
    if (
      run.status !== 'cancelling' &&
      registered?.singleton &&
      !(await this.singletons.admit(run, registered.singleton))
    ) {
      const wakeAt = this.singletons.retryWakeAt();
      await this.store.updateRun(run.id, { status: 'suspended', wakeAt, updatedAt: new Date() });
      this.emit({
        type: 'run.suspended',
        runId: run.id,
        workflow: run.workflow,
        namespace: run.namespace,
      });
      await this.store.releaseRunLock(run.id);
      return { runId: run.id, status: 'suspended' };
    }
    // Saga compensations registered by completed steps; run in reverse if the run later fails.
    const compensations: Compensation[] = [];
    // Load this run's checkpoints ONCE and key them by seq, so replaying the completed prefix reads
    // from memory instead of one `getCheckpoint` SELECT per primitive (the O(N²) replay-reads fix).
    // Read once at execution start: a checkpoint written AFTER this snapshot (the signal/timer/child
    // this resume wakes on, or one written later in this same execution) is absent from the map, and
    // the ctx falls back to the live store for any absent seq — so replay semantics are unchanged.
    const snapshot = await this.store.listCheckpoints(run.id);
    const replay = new Map<number, StepCheckpoint>();
    for (const cp of snapshot) replay.set(cp.seq, cp);
    const ctx = createWorkflowCtx(
      this.ctxHostFor(replay, run.namespace),
      run.id,
      compensations,
      run.workflow,
      registered?.searchAttributesSchema,
    );
    try {
      // The ambient-context wrap is what lets class-first statics (`MyWorkflow.execute()`) find
      // this ctx from anywhere on the body's async path — first run and every replay alike.
      const output = await runInWorkflowCtx(ctx, () => fn(ctx, run.input));
      // A compensating cancel may have been requested while this turn ran (or re-derived from a
      // `cancelling` status on recovery): undo + settle cancelled rather than completing, so the cancel
      // is never lost when the body returns without first hitting a suspension point.
      if (this.cancelRequested.has(run.id)) {
        return this.compensateAndCancel(run, compensations, replay);
      }
      return this.settleRun(run, { kind: 'completed', output });
    } catch (err) {
      if (err instanceof ContinueAsNew) {
        // A cancel in flight wins over continue-as-new: undo + cancel instead of spawning the next run.
        if (this.cancelRequested.has(run.id)) {
          return this.compensateAndCancel(run, compensations, replay);
        }
        // Hand off to a fresh execution with a clean history: complete this run, then start the next
        // (`<id>~N`) with the new input. Deferred + idempotent by the continuation id, so a crash
        // mid-handoff re-derives the same next run instead of forking.
        await this.store.updateRun(run.id, {
          status: 'completed',
          output: undefined,
          error: undefined,
          updatedAt: new Date(),
        });
        this.emit({
          type: 'run.completed',
          runId: run.id,
          workflow: run.workflow,
          namespace: run.namespace,
        });
        void this.notifyParent(run.id, { ok: true, value: undefined });
        const nextId = nextContinuationId(run.id);
        queueMicrotask(
          () => void this.start(run.workflow, err.input, nextId).catch(() => undefined),
        );
        return { runId: run.id, status: 'completed' };
      }
      if (err instanceof WorkflowSuspended) {
        // A compensating cancel resumed this run to reach here: undo + cancel instead of re-suspending.
        if (this.cancelRequested.has(run.id)) {
          return this.compensateAndCancel(run, compensations, replay);
        }
        return this.settleRun(run, { kind: 'suspended', wakeAt: err.wakeAt });
      }
      // A cancel in flight that surfaced as a thrown error still settles cancelled (not failed) — the
      // saga undo runs either way; this just keeps the terminal status faithful to the cancel request.
      if (this.cancelRequested.has(run.id)) {
        return this.compensateAndCancel(run, compensations, replay);
      }
      const error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      // Saga: undo completed steps in reverse — local ones in-process, dispatched ones as durable
      // remote-step dispatches (see `unwindCompensations`) — each made VISIBLE as a `compensate:<step>`
      // step event/checkpoint so a stranded undo is never silently swallowed; a failing one is still
      // skipped so it can't mask the original failure or strand the rest (compensations should be
      // idempotent). A dispatched undo still in flight (or backing off a retry) SUSPENDS the run
      // exactly like an ordinary `ctx.step` dispatch — the next re-drive (the worker's result landing,
      // or the retry backoff elapsing) resumes `unwindCompensations` right where it left off.
      const pending = await this.unwindCompensations(run, compensations, replay);
      if (pending) return this.settleRun(run, { kind: 'suspended', wakeAt: pending.wakeAt });
      return this.settleRun(run, { kind: 'failed', error });
    } finally {
      // Release the recovery lease once the run reaches a terminal/suspended state, so the
      // next instance (or the timer poller) can pick it up promptly.
      await this.store.releaseRunLock(run.id);
    }
  }

  /**
   * Undo every registered saga compensation in strict reverse order — the shared unwind both the
   * run-failure path (`runExecution`'s catch) and the compensating-cancel path
   * (`compensateAndCancel`) drive. Every entry, LOCAL or DISPATCHED, gets a NEGATIVE checkpoint seq
   * `-(k + 1)` for its position `k` (0, 1, 2… walking the stack in reverse) — reserved space that can
   * never collide with a body position (those start at 0), so a saga's undo trail composes onto the
   * run's ordinary checkpoint history with no store-schema change, and shows up in run detail exactly
   * like any other step. Deterministic because `compensations` is rebuilt identically on every replay
   * (see `workflow-ctx.ts`), so the same comp always lands on the same negative seq across a crash +
   * re-drive — the crash-safety this whole scheme rests on.
   *
   * A LOCAL entry runs in-process (`runCompensation`), which checkpoints its own outcome — completed,
   * or failed once `compensationRetries` are exhausted — so a crash mid-unwind SKIPS an
   * already-resolved one on the next pass instead of re-running it (and re-spending its retry budget)
   * from attempt 1. A DISPATCHED entry is an ordinary remote-step dispatch under the hood
   * (`dispatchCompensation`): when it needs the run to WAIT — freshly dispatched, still in flight, or
   * backing off a durable retry — this function returns that wait signal immediately (skipping every
   * comp after it in this pass); the CALLER decides how to represent "still unwinding" (see
   * `compensateAndCancel`'s doc comment for why that differs between the two callers). Either way, the
   * run resumes later exactly like any other dispatched step: `completeRemoteResult` completes the
   * negative-seq checkpoint and re-drives, the body replays and deterministically re-throws the same
   * exit it took before (the original failure, or the suspension `compensateAndCancel` resumed from),
   * this function runs again, the now-resolved comp is skipped, and the unwind continues from there.
   *
   * Returns `undefined` once every compensation has resolved — the caller then finalizes the run
   * (`failed` with the ORIGINAL body error, never masked by a comp outcome; or `cancelled`).
   */
  private async unwindCompensations(
    run: WorkflowRun,
    compensations: Compensation[],
    replay?: Map<number, StepCheckpoint>,
  ): Promise<UnwindPending | undefined> {
    for (let i = compensations.length - 1; i >= 0; i -= 1) {
      const comp = compensations[i];
      if (!comp) continue;
      const seq = -(compensations.length - i);
      if ('fn' in comp) {
        const existing = replay?.get(seq) ?? (await this.store.getCheckpoint(run.id, seq));
        if (existing) continue; // already resolved (completed or exhausted-failed) in an earlier pass
        await this.runCompensation(run, comp, seq, replay);
        continue;
      }
      const pending = await this.dispatchCompensation(run, comp, seq, replay);
      if (pending) return pending;
    }
    return undefined;
  }

  /**
   * Run one LOCAL saga compensation, retried up to `compensationRetries`, emitting a
   * `compensate:<step>` step event for its outcome so a stranded undo is visible. Never throws — a
   * permanently-failing compensation is skipped so it can't mask the original failure. Checkpoints
   * its outcome at `seq` (a negative unwind position reserved by {@link unwindCompensations}) so a
   * crash mid-unwind skips an already-resolved undo on a later pass instead of re-running it (and
   * re-spending its retry budget) from attempt 1 — the checkpoint is durability/visibility only; the
   * runtime retry-in-process-back-to-back semantics of `comp.fn()` are unchanged.
   */
  private async runCompensation(
    run: WorkflowRun,
    comp: Extract<Compensation, { fn: () => Promise<void> }>,
    seq: number,
    replay?: Map<number, StepCheckpoint>,
  ): Promise<void> {
    const name = `compensate:${comp.name}`;
    const enqueuedAt = new Date();
    for (let attempt = 1; attempt <= this.compensationRetries; attempt += 1) {
      const startedAt = new Date();
      try {
        await comp.fn();
        this.emit({
          type: 'step.completed',
          runId: run.id,
          workflow: run.workflow,
          name,
          kind: 'local',
          durationMs: Date.now() - startedAt.getTime(),
        });
        const cp = stepCheckpoint({
          runId: run.id,
          seq,
          name,
          kind: 'local',
          status: 'completed',
          attempts: attempt,
          enqueuedAt,
          startedAt,
          finishedAt: new Date(),
        });
        await this.store.saveCheckpoint(cp);
        replay?.set(seq, cp);
        return;
      } catch (err) {
        if (attempt >= this.compensationRetries) {
          const error = { message: err instanceof Error ? err.message : String(err) };
          this.emit({
            type: 'step.failed',
            runId: run.id,
            workflow: run.workflow,
            name,
            kind: 'local',
            error,
            durationMs: Date.now() - startedAt.getTime(),
          });
          const cp = stepCheckpoint({
            runId: run.id,
            seq,
            name,
            kind: 'local',
            status: 'failed',
            attempts: attempt,
            error,
            enqueuedAt,
            startedAt,
            finishedAt: new Date(),
          });
          await this.store.saveCheckpoint(cp);
          replay?.set(seq, cp);
        }
      }
    }
  }

  /**
   * Resolve (or advance) ONE dispatched saga compensation at its reserved negative `seq` — the undo
   * handler is an ordinary remote `@Step`, so this mirrors `callRemote`'s pending/failed/absent
   * branches (engine.ts's `callRemote`), minus the queue/admission and in-memory-`timeoutMs` paths
   * (V1: dispatch direct by name, always durable). Returns the wait signal when the run must pause for
   * this compensation (freshly dispatched, still in flight, or backing off before a durable retry);
   * `undefined` once it's resolved — completed (crash-safe skip), or retries exhausted/non-retryable
   * (already visible: `completeRemoteResult` emitted `step.failed` for `compensate:<name>` when that
   * checkpoint landed — never re-emitted here, and never allowed to block the rest of the unwind or
   * mask the run's original failure).
   */
  private async dispatchCompensation(
    run: WorkflowRun,
    comp: Extract<Compensation, { dispatch: unknown }>,
    seq: number,
    replay?: Map<number, StepCheckpoint>,
  ): Promise<UnwindPending | undefined> {
    const { def, args } = comp.dispatch;
    const name = `compensate:${comp.name}`;
    const existing = replay?.get(seq) ?? (await this.store.getCheckpoint(run.id, seq));
    if (existing?.status === 'completed') return undefined;
    if (existing?.status === 'pending') return {}; // dispatched, awaiting the worker's result
    if (existing?.status === 'failed') {
      const maxAttempts = Math.max(1, def.retries ?? 1);
      const retryable = existing.error?.retryable !== false;
      if (!retryable || existing.attempts >= maxAttempts) return undefined;
      if (existing.wakeAt == null) {
        const wakeAt = this.clock() + backoffDelay(existing.attempts, def);
        const withWakeAt = { ...existing, wakeAt };
        await this.store.saveCheckpoint(withWakeAt);
        replay?.set(seq, withWakeAt);
        return { wakeAt };
      }
      if (this.clock() < existing.wakeAt) return { wakeAt: existing.wakeAt };
      await this.dispatchCompensationAttempt(
        run,
        seq,
        name,
        def,
        args,
        existing.attempts + 1,
        replay,
      );
      return {};
    }
    // Absent: first dispatch.
    await this.dispatchCompensationAttempt(run, seq, name, def, args, 1, replay);
    return {};
  }

  /**
   * Dispatch (or re-dispatch, on a durable retry) one compensation's undo handler — mirrors
   * `callRemote`'s dispatch block (persist the `pending` checkpoint BEFORE handing off to the
   * transport, so a fast result always finds it to complete). Two DIFFERENT names are in play: the
   * checkpoint's `name` is `compensate:<originalStepName>` (what makes this undo show up on the run's
   * timeline, and what `completeRemoteResult` emits `step.completed`/`step.failed` under); the WIRE
   * task's `name` is the undo handler's OWN routing name (`def.name`) — a worker dispatches to the
   * `@Step` it registered, not to this saga-visibility label.
   */
  private async dispatchCompensationAttempt(
    run: WorkflowRun,
    seq: number,
    name: string,
    def: StepDef<StepUndo<unknown, unknown>, unknown>,
    args: StepUndo<unknown, unknown>,
    attempt: number,
    replay?: Map<number, StepCheckpoint>,
  ): Promise<void> {
    if (this.pool.size === 0) throw new Error('remote steps require a Transport');
    const group = tenantGroup(sanitizeQueueToken(def.name), def.partition);
    const enqueuedAt = new Date();
    const cp = stepCheckpoint({
      runId: run.id,
      seq,
      name,
      kind: 'remote',
      status: 'pending',
      input: args,
      attempts: attempt,
      workerGroup: group,
      enqueuedAt,
      startedAt: enqueuedAt,
      finishedAt: enqueuedAt,
    });
    await this.store.saveCheckpoint(cp);
    replay?.set(seq, cp);
    await this.pool.dispatch({
      runId: run.id,
      seq,
      name: def.name,
      stepId: cp.stepId,
      group,
      input: args,
      traceparent: this.traceparent?.(),
      context: this.context?.(),
      attempt,
    });
    this.emit({ type: 'step.started', runId: run.id, seq, name, kind: 'remote' });
  }

  /** The seam handed to {@link createWorkflowCtx}: the authoring API reaches durability + lifecycle
   *  (checkpointing, dispatch, child start) through this, so the ctx primitives live in their own
   *  module and the engine stays the orchestrator. */
  private ctxHostFor(replay?: Map<number, StepCheckpoint>, parentNamespace?: string): CtxHost {
    return {
      store: this.store,
      replay,
      clock: this.clock,
      webhookUrl: this.webhookUrl,
      startStep: (s) => this.startStep(s),
      completeStep: (s) => this.completeStep(s),
      failStep: (s) => this.failStep(s),
      callRemote: (runId, seq, step, input, queue, transport, admission) =>
        this.callRemote(runId, seq, step, input, queue, transport, replay, admission),
      // Defer so a fast child can't reentrantly resume a still-running parent. Stamp the child with
      // the PARENT run's namespace (not this engine's) so a child belongs to the tenant/partition of
      // the run it was spawned from — even when an operator (namespace: undefined, drives every
      // namespace) is the one executing the parent. Otherwise an operator recovery-resuming a
      // `davi-local` pipeline would stamp its `processing` child `default` and it would leak off the
      // tenant's worker pool onto the shared/dev workers.
      startChild: (workflow, input, id, priority) => {
        this.startChildDeferred(workflow, input, id, { priority, namespace: parentNamespace });
      },
      // Deferred for the same reentrancy reason as `startChild` above. `cancel()` is already
      // idempotent on a terminal/cancelled run (returns its existing status without side effects), so
      // no extra guard is needed here for the failFast replay case (re-issuing the same cancel calls).
      cancelChild: (childId) => {
        queueMicrotask(() => void this.cancel(childId).catch(() => undefined));
      },
      // Shallow-merge into the run's searchAttributes (the ctx primitive makes this exactly-once).
      upsertSearchAttributes: async (runId, attrs) => {
        const run = await this.store.getRun(runId);
        await this.store.updateRun(runId, {
          searchAttributes: { ...(run?.searchAttributes ?? {}), ...attrs },
          updatedAt: new Date(),
        });
      },
      signalEntity: (name, key, op, arg, reply) => {
        queueMicrotask(
          () => void this.entities.dispatch(name, key, op, arg, reply).catch(() => undefined),
        );
      },
      interceptStep: (invocation, body) => this.interceptStep(invocation, body),
    };
  }

  /**
   * Resume a run paused at a {@link WorkflowCtx.breakpoint} (e.g. the dashboard "continue" button).
   * Finds the run's pending breakpoint checkpoint and signals it. Returns null if the run isn't
   * paused at a breakpoint.
   */
  async continue(runId: string): Promise<RunResult | null> {
    const checkpoints = await this.store.listCheckpoints(runId);
    const bp = checkpoints.find(isBreakpoint);
    if (!bp) return null;
    return this.signal(breakpointToken(runId, bp.seq), undefined);
  }

  /**
   * Read the latest value a run published for `key` via {@link WorkflowCtx.setEvent} — a
   * side-effect-free query of a live (or finished) run's state. Returns `undefined` if the run
   * never published that key. The suspend-model counterpart of a Temporal query.
   */
  async getEvent<TValue = unknown>(runId: string, key: string): Promise<TValue | undefined> {
    const name = `event:${key}`;
    // Targeted read: the highest-seq checkpoint for this name is the most recent value (a re-published
    // key overwrites at a higher seq), matching the old "last in seq order wins" scan. Falls back to a
    // full listCheckpoints scan (last match in seq-ascending order wins) for a store that omits it.
    if (this.store.getLatestCheckpointByName) {
      const latest = await this.store.getLatestCheckpointByName(runId, name);
      return latest?.output as TValue | undefined;
    }
    // listCheckpoints is ordered by seq ascending, so the last match is the most recent value.
    let latest: TValue | undefined;
    for (const cp of await this.store.listCheckpoints(runId))
      if (cp.name === name) latest = cp.output as TValue;
    return latest;
  }

  /**
   * Register a validator gating `engine.update(runId, name, …)` for runs of `workflow`. The
   * validator runs BEFORE the update is delivered, so a rejection leaves the run untouched. One
   * validator per (workflow, update name); registering again replaces it.
   */
  registerUpdateValidator<TArg>(
    workflow: string,
    name: string,
    validate: UpdateValidator<TArg>,
  ): void {
    this.updateValidators.set(`${workflow}:${name}`, validate as UpdateValidator);
  }

  /**
   * Deliver a validated update to the run waiting at `ctx.onUpdate(name)`. Runs the registered
   * validator (if any) first: on rejection returns `{ accepted: false, reason }` without disturbing
   * the run; otherwise delivers `arg` and resumes, returning `{ accepted: true, run }` (`run` is null
   * if nothing was waiting — a too-early or duplicate update).
   */
  async update(runId: string, name: string, arg: unknown): Promise<UpdateResult> {
    const run = await this.store.getRun(runId);
    if (!run) return { accepted: false, reason: `run ${runId} not found` };
    const validate = this.updateValidators.get(`${run.workflow}:${name}`);
    if (validate) {
      try {
        const reason = await validate(arg);
        if (typeof reason === 'string' && reason.length > 0) return { accepted: false, reason };
      } catch (err) {
        return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    const result = await this.signal(`update:${runId}:${name}`, arg);
    return { accepted: true, run: result };
  }

  private async callRemote<TInput, TOutput>(
    runId: string,
    seq: number,
    step: StepDef<TInput, TOutput>,
    input: TInput,
    queue?: string,
    transport?: string,
    replay?: Map<number, StepCheckpoint>,
    admission?: { priority?: number | undefined; fairnessKey?: string | undefined },
  ): Promise<TOutput> {
    // Read the prefix from the per-execution snapshot (avoids the O(N²) replay SELECTs); a seq absent
    // from the snapshot — not yet dispatched, or written after the snapshot — falls back to the store.
    const existing = replay?.get(seq) ?? (await this.store.getCheckpoint(runId, seq));
    if (existing && existing.name !== step.name) {
      throw new NonDeterminismError(runId, seq, step.name, existing.name);
    }
    if (existing?.status === 'completed') return existing.output as TOutput;
    if (this.pool.size === 0) throw new Error('remote steps require a Transport');
    // A step with a liveness `timeoutMs` keeps the in-memory await + heartbeat path (re-dispatch a
    // presumed-dead worker). Without one, the call SUSPENDS DURABLY: dispatch, persist a `pending`
    // checkpoint, and let the result resume the run on whichever instance receives it — so a worker
    // pod can scale down or crash mid-step without losing the run or re-running completed work.
    if (step.timeoutMs) return this.callRemoteInMemory(runId, seq, step, input, transport);
    if (existing?.status === 'pending') {
      // Dispatched; normally we just keep waiting for the result to resume the run. But a LOST dispatch
      // (worker crashed with no result, or the transport dropped the job) would hang here forever — a
      // reconcile re-drive replays straight back to this guard. Opt-in self-heal: once the step has been
      // pending longer than `remoteRedispatchMs`, re-dispatch the same stepId (the idempotent step
      // re-runs, its result resumes the run), bounded by `remoteRedispatchMax` so a never-settling step
      // fails instead of looping. Unset (default) keeps the by-design "re-suspend, never re-dispatch".
      if (this.remoteRedispatchMs == null) throw new WorkflowSuspended();
      // Stamp a redispatch deadline (clock-space, persisted) the first time we see this pending step,
      // stable across replays and crashes — mirrors the failed-retry backoff below. The run's wakeAt
      // becomes this deadline, so a reconcile re-drive lands exactly when it's due to re-dispatch.
      if (existing.wakeAt == null) {
        const wakeAt = this.clock() + this.remoteRedispatchMs;
        await this.store.saveCheckpoint({ ...existing, wakeAt });
        throw new WorkflowSuspended(wakeAt);
      }
      if (this.clock() < existing.wakeAt) throw new WorkflowSuspended(existing.wakeAt);
      // Past the deadline with no result — the dispatch is presumed lost. Re-dispatch (bounded by
      // `remoteRedispatchMax` so a step that never settles fails the run instead of looping forever).
      if (existing.attempts >= this.remoteRedispatchMax) {
        throw new RemoteStepError({
          message: `remote step "${step.name}" lost — no result after ${existing.attempts} re-dispatch(es)`,
          code: 'remote_step_lost',
        });
      }
      const reAttempt = existing.attempts + 1;
      const nextDeadline = this.clock() + this.remoteRedispatchMs;
      const reEnqueuedAt = new Date();
      await this.store.saveCheckpoint({
        ...existing,
        attempts: reAttempt,
        wakeAt: nextDeadline,
        enqueuedAt: reEnqueuedAt,
        startedAt: reEnqueuedAt,
        finishedAt: reEnqueuedAt,
      });
      await this.dispatchRemoteTask({
        runId,
        seq,
        name: step.name,
        stepId: existing.stepId ?? stepId(runId, seq),
        group: existing.workerGroup ?? tenantGroup(sanitizeQueueToken(step.name), step.partition),
        input: existing.input,
        priority: admission?.priority,
        attempt: reAttempt,
        transport,
      });
      throw new WorkflowSuspended(nextDeadline);
    }

    // Durable retry: a failed attempt re-dispatches up to `retries`, spacing attempts by `backoff` —
    // unless the worker marked the error non-retryable (a deterministic verdict like a declined card).
    // The retry deadline is stamped on the failed checkpoint as `wakeAt` (clock-space, persisted) the
    // first time we see it, so it's stable across replays and survives a crash.
    let attempt = 1;
    if (existing?.status === 'failed') {
      const maxAttempts = Math.max(1, step.retries ?? 1);
      const retryable = existing.error?.retryable !== false;
      if (!retryable || existing.attempts >= maxAttempts) throw new RemoteStepError(existing.error);
      if (existing.wakeAt == null) {
        const wakeAt = this.clock() + backoffDelay(existing.attempts, step);
        await this.store.saveCheckpoint({ ...existing, wakeAt });
        throw new WorkflowSuspended(wakeAt);
      }
      if (this.clock() < existing.wakeAt) throw new WorkflowSuspended(existing.wakeAt);
      attempt = existing.attempts + 1;
    }

    const id = stepId(runId, seq);
    // Flow control: a queued call that can't be admitted (concurrency/rate) does NOT dispatch — the
    // run re-suspends with the queue's retry time and the timer poller re-tries admission later, so
    // the limit is durable. The admitted slot is released when the result lands (completeRemoteResult).
    if (queue && this.admission.handles(queue)) {
      // Admission carries the per-call priority + fairness key (default the runId so each run is its
      // own fairness bucket), and the stepId as a STABLE waiter id so the backend tracks one waiter
      // across this call's durable retries. Ordering lives in the backend (in-process by default, or
      // global) — this is the dispatch/admission layer, not the positional replay path.
      const decision = await this.admission.tryAdmit(queue, {
        priority: admission?.priority,
        key: admission?.fairnessKey ?? runId,
        waiterId: id,
      });
      if (!decision.ok) {
        // Remember this run as blocked on `queue` so a freed-slot signal can wake it early.
        const waiters = this.queueWaiters.get(queue) ?? new Set<string>();
        waiters.add(runId);
        this.queueWaiters.set(queue, waiters);
        throw new WorkflowSuspended(decision.retryAt);
      }
      this.queueWaiters.get(queue)?.delete(runId);
      this.stepQueue.set(id, queue);
    }

    const enqueuedAt = new Date();
    // Persist the pending checkpoint BEFORE dispatching, so a fast result always finds it to complete.
    await this.store.saveCheckpoint({
      runId,
      seq,
      name: step.name,
      kind: 'remote',
      stepId: id,
      status: 'pending',
      input,
      attempts: attempt,
      workerGroup: tenantGroup(sanitizeQueueToken(step.name), step.partition),
      enqueuedAt,
      startedAt: enqueuedAt, // placeholders until the worker result lands
      finishedAt: enqueuedAt,
    });
    await this.dispatchRemoteTask({
      runId,
      seq,
      name: step.name,
      stepId: id,
      group: tenantGroup(sanitizeQueueToken(step.name), step.partition),
      input,
      priority: admission?.priority,
      attempt,
      transport,
    });
    this.emit({ type: 'step.started', runId, seq, name: step.name, kind: 'remote' });
    throw new WorkflowSuspended();
  }

  /** Enqueue a remote step task to its worker group via the transport pool. Shared by the initial
   *  dispatch, the opt-in self-heal re-dispatch (see `remoteRedispatchMs`), and the explicit
   *  {@link redispatchPending}. Carries the current trace/context so a re-dispatch is traceable. */
  private dispatchRemoteTask(task: {
    runId: string;
    seq: number;
    name: string;
    stepId: string;
    group: string;
    input: unknown;
    attempt: number;
    priority?: number | undefined;
    transport?: string | undefined;
  }): Promise<void> {
    return this.pool.dispatch(
      {
        runId: task.runId,
        seq: task.seq,
        name: task.name,
        stepId: task.stepId,
        group: task.group,
        input: task.input,
        traceparent: this.traceparent?.(),
        context: this.context?.(),
        priority: task.priority,
        attempt: task.attempt,
      },
      task.transport,
    );
  }

  /**
   * Complete a durable remote step from its worker result and resume the run — runs on whichever
   * instance receives the result (the dispatching one may be gone), so the run is crash/scale-safe.
   * A no-op if the checkpoint isn't `pending` (a duplicate or late delivery).
   */
  private async completeRemoteResult(result: StepResult): Promise<void> {
    const cp = await this.store.getCheckpoint(result.runId, result.seq);
    if (!cp || cp.status !== 'pending') return;
    // A result settling this step frees its flow-control slot (no-op if it wasn't queued). Done
    // before the cancelled-run early-return below, so a cancellation can't leak the slot. Released
    // fire-and-forget: the slot/notify is best-effort (a global backend self-heals via lease), and
    // not awaiting keeps it off the result-processing critical path (no ordering shift).
    void this.releaseQueueSlot(cp.stepId).catch(() => undefined);
    // Drop a late result for a run that was cancelled/finished meanwhile — don't complete the step
    // or resume (the run is already terminal). This is the engine side of cooperative cancellation.
    const run = await this.store.getRun(result.runId);
    if (run && (run.status === 'cancelled' || run.status === 'completed')) return;
    const finishedAt = new Date();
    const startedAt = result.startedAt ? new Date(result.startedAt) : cp.startedAt;
    await this.store.saveCheckpoint({
      ...cp,
      status: result.status,
      output: result.status === 'completed' ? result.output : cp.output,
      error: result.error,
      events: result.events ?? cp.events,
      startedAt,
      finishedAt,
    });
    this.emit({
      type: result.status === 'completed' ? 'step.completed' : 'step.failed',
      runId: result.runId,
      seq: result.seq,
      name: cp.name,
      kind: cp.kind,
      output: result.output,
      error: result.error,
      queueMs: startedAt.getTime() - cp.enqueuedAt.getTime(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
    await this.resume(result.runId).catch((err) => {
      if (err instanceof NamespaceMismatch) return null;
      throw err;
    });
  }

  /**
   * Apply a remote workflow-turn {@link WorkflowDecision} durably — runs on WHATEVER instance receives
   * it over the broker (the dispatching one may be gone, or a point-to-point broker handed it to a
   * non-dispatcher). The durable, multi-instance-safe twin of {@link completeRemoteResult} for the
   * workflow TURN: look the run up by `decision.runId`, verify the decision matches the run's
   * CURRENTLY-awaited turn (`awaitingDecisionTaskId`) — so a stale / duplicate / foreign / re-driven
   * decision is dropped (applied AT MOST ONCE) — lease it, clear the marker, and apply the decision.
   */
  private async completeRemoteDecision(decision: WorkflowDecision): Promise<void> {
    // Cheap pre-checks before contending for the lease: only the run currently awaiting THIS taskId
    // (and not already terminal) is a candidate. A re-driven turn has a different taskId, so a late
    // decision for the prior turn is dropped here.
    const run = await this.store.getRun(decision.runId);
    if (!run || run.awaitingDecisionTaskId !== decision.taskId) return;
    if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'dead') return;
    if (
      this.namespace !== undefined &&
      run.namespace !== undefined &&
      run.namespace !== this.namespace
    ) {
      return;
    }
    const nowMs = this.clock();
    // Lease so exactly one instance applies it — serialized with a concurrent timer re-drive of the
    // same run. If the lease is held (a re-drive in flight), drop: the re-driven turn produces a fresh
    // decision. The common single-decision path is uncontended, so this acquires immediately.
    if (
      !(await this.store.tryLockRun(decision.runId, this.instanceId, nowMs + this.leaseMs, nowMs))
    ) {
      return;
    }
    const renew = setInterval(
      () => {
        void this.store
          .renewRunLock(decision.runId, this.instanceId, this.clock() + this.leaseMs)
          .catch(() => undefined);
      },
      Math.max(50, Math.floor(this.leaseMs / 2)),
    );
    renew.unref?.();
    try {
      // Re-read under the lease and re-check the marker — it may have changed (a re-drive applied
      // first, or another decision raced in) between the unlocked pre-check and acquiring the lease.
      const fresh = await this.store.getRun(decision.runId);
      if (!fresh || fresh.awaitingDecisionTaskId !== decision.taskId) return;
      if (fresh.status === 'cancelled' || fresh.status === 'completed' || fresh.status === 'dead') {
        return;
      }
      // Clear the awaited-turn marker and the re-drive deadline: this turn is now being applied exactly
      // once. `applyDecision` resets `wakeAt` itself when it suspends on the turn's blocking ops.
      await this.store.updateRun(decision.runId, {
        awaitingDecisionTaskId: undefined,
        wakeAt: undefined,
        updatedAt: new Date(),
      });
      fresh.awaitingDecisionTaskId = undefined;
      await this.applyDecision(fresh, decision);
    } finally {
      clearInterval(renew);
      await this.store.releaseRunLock(decision.runId);
    }
  }

  /**
   * A run-scoped heartbeat for a run suspended awaiting a workflow-turn decision (the dispatch path):
   * push its durable re-drive deadline (`wakeAt`) forward so a still-working worker's turn is not
   * re-dispatched. The durable counterpart of an inline turn's in-memory `heartbeatResets` rearm.
   */
  private async rearmDecisionDeadline(runId: string): Promise<void> {
    const silenceMs = this.remoteAdvanceSilenceMs;
    if (silenceMs == null) return;
    const run = await this.store.getRun(runId);
    if (!run || run.status !== 'suspended' || run.awaitingDecisionTaskId === undefined) return;
    await this.store.updateRun(runId, { wakeAt: this.clock() + silenceMs, updatedAt: new Date() });
  }

  /**
   * A slot freed on `queue` (a fleet-wide signal): resume this instance's runs blocked on it so they
   * re-contend now instead of at their retry tick. Snapshot-and-clear — a run still blocked after the
   * retry re-registers itself, and one that's gone (cancelled/admitted) is dropped. Best-effort.
   */
  private wakeQueueWaiters(queue: string): void {
    const waiters = this.queueWaiters.get(queue);
    if (!waiters || waiters.size === 0) return;
    const runIds = [...waiters];
    waiters.clear();
    for (const runId of runIds) void this.resume(runId).catch(() => undefined);
  }

  /** Release the flow-control slot a dispatched step held (if any), by its stepId. */
  private async releaseQueueSlot(id: string): Promise<void> {
    const queue = this.stepQueue.get(id);
    if (queue === undefined) return;
    this.stepQueue.delete(id);
    await this.admission.release(queue, id);
  }

  /** In-memory await path for a remote step with a liveness `timeoutMs` (re-dispatch on timeout). */
  private async callRemoteInMemory<TInput, TOutput>(
    runId: string,
    seq: number,
    step: StepDef<TInput, TOutput>,
    input: TInput,
    transport?: string,
  ): Promise<TOutput> {
    if (this.pool.size === 0) throw new Error('remote steps require a Transport');
    // A bare `@Step()` (no `input`/`output` schemas attached) skips validation.
    const validInput = step.input ? step.input.parse(input) : input;
    const id = stepId(runId, seq);
    const enqueuedAt = new Date();
    this.emit({ type: 'step.started', runId, seq, name: step.name, kind: 'remote' });
    // Retry policy differs from an in-process step on purpose: the internal in-process primitives
    // (`ctx.task`'s dispatch, `ctx.now`/`ctx.sideEffect`) retry any non-fatal throw (the work is in-process),
    // but a dispatched `ctx.step` only re-dispatches on a liveness TIMEOUT (presumed-dead worker). A
    // worker that *reported* an error returned a deterministic verdict, so we surface it to the
    // workflow instead of hammering the worker. Timeout retries need a window to detect death, so
    // they're gated on `timeoutMs` being set.
    const maxAttempts = step.timeoutMs ? Math.max(1, step.retries ?? 1) : 1;

    for (let attempt = 1; ; attempt += 1) {
      const resultPromise = new Promise<RemoteResolution>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
      });
      await this.pool.dispatch(
        {
          runId,
          seq,
          name: step.name,
          stepId: id,
          group: tenantGroup(sanitizeQueueToken(step.name), step.partition),
          input: validInput,
          traceparent: this.traceparent?.(),
          context: this.context?.(),
          attempt,
        },
        transport,
      );
      try {
        const resolution = step.timeoutMs
          ? await this.awaitWithHeartbeat(id, resultPromise, step.timeoutMs)
          : await resultPromise;
        const output = step.output
          ? (step.output.parse(resolution.output) as TOutput)
          : (resolution.output as TOutput);
        // The worker reports when it actually picked the task up; fall back to dispatch time if a
        // transport doesn't carry it (queue-wait then reads as zero rather than going negative).
        const startedAt = resolution.startedAt ? new Date(resolution.startedAt) : enqueuedAt;
        await this.completeStep({
          runId,
          seq,
          name: step.name,
          kind: 'remote',
          input: validInput,
          output,
          events: resolution.events,
          attempts: attempt,
          workerGroup: tenantGroup(sanitizeQueueToken(step.name), step.partition),
          enqueuedAt,
          startedAt,
        });
        return output;
      } catch (err) {
        this.pending.delete(id);
        if (err instanceof RemoteStepTimeout && attempt < maxAttempts) continue;
        throw err;
      }
    }
  }

  /**
   * Await `resultPromise`, but reject with `onTimeout()` if neither it settles nor a heartbeat for `id`
   * arrives within `timeoutMs`. Each heartbeat (delivered via `transport.onHeartbeat`, looked up in
   * `heartbeatResets` by `id`) REARMS the window, so a worker that keeps beating stays alive past
   * `timeoutMs`. Shared by the remote-STEP liveness (keyed by stepId) and the remote-WORKFLOW advance
   * liveness (keyed by runId); the caller supplies the timeout error and any extra cleanup via `onTimeout`.
   */
  private awaitWithLivenessDeadline<T>(
    id: string,
    resultPromise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => Error,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        this.heartbeatResets.delete(id);
      };
      const arm = () => {
        timer = setTimeout(() => {
          cleanup();
          reject(onTimeout());
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      };
      this.heartbeatResets.set(id, () => {
        clearTimeout(timer);
        arm();
      });
      arm();
      resultPromise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
  }

  /** Remote-STEP liveness: await a worker result, timing out (with the step's pending-map cleanup) to
   *  `RemoteStepTimeout` if it neither lands nor beats within `timeoutMs`. See {@link awaitWithLivenessDeadline}. */
  private awaitWithHeartbeat(
    id: string,
    resultPromise: Promise<RemoteResolution>,
    timeoutMs: number,
  ): Promise<RemoteResolution> {
    return this.awaitWithLivenessDeadline(id, resultPromise, timeoutMs, () => {
      this.pending.delete(id);
      return new RemoteStepTimeout(id, timeoutMs);
    });
  }
}

/** Raised inside the workflow when a remote worker reports a step failure. */
export class RemoteStepError extends Error {
  readonly stepError?: StepError | undefined;
  constructor(stepError?: StepError) {
    super(stepError?.message ?? 'remote step failed');
    this.name = 'RemoteStepError';
    this.stepError = stepError;
  }
}
