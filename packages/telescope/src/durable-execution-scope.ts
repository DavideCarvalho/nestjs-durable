import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { DurableExecution, DurableExecutionWrapper } from '@dudousxd/nestjs-durable-core';
import type { WatcherContext } from '@dudousxd/nestjs-telescope';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { runTraceContext, runTraceId } from './durable-run-trace';

/** What the scope publishes to anything recording on this async path. */
export interface DurableScope {
  /** The run whose unit of work is executing. */
  readonly runId: string;
  /** The run's trace — see {@link runTraceId}. */
  readonly traceId: string;
  /** This scope's span within that trace. Stable for every entry recorded inside it. */
  readonly spanId: string;
  /**
   * Identity of the wrapper that opened this scope. Reuse is only ever offered to the wrapper that
   * owns the scope: two Telescope instances in one process (a torn-down test module whose wrapper
   * outlived it, an app that mounts two consoles) would otherwise have the first one's scope
   * silently suppress the second one's batch, and the second console would record everything
   * batchless while looking correctly wired.
   */
  readonly owner: object;
}

/**
 * The durable scope THIS package has open on the current async path, if any.
 *
 * Telescope's own batch context is not readable from a watcher (`WatcherContext` exposes
 * `runInBatch`/`beginBatch` but no `currentBatch()`), and we would not want to read it even if it
 * were: the question is not "is any batch open" — an HTTP request that happened to start a run
 * inline has one — but "is the scope on this path the one we opened for this same run".
 */
const activeScope = new AsyncLocalStorage<DurableScope>();

/** The durable execution scope active on this async path, or undefined outside one. */
export function currentDurableScope(): DurableScope | undefined {
  return activeScope.getStore();
}

/** `BatchOrigin` has no durable/workflow member — see {@link durableExecutionScope} for the choice. */
const DURABLE_BATCH_ORIGIN = 'queue';

function spanName(execution: DurableExecution): string {
  if (execution.unit === 'step') return `step ${execution.name ?? '?'}`;
  return `workflow ${execution.workflow ?? '?'}`;
}

function spanAttributes(execution: DurableExecution): Record<string, string | number> {
  const attributes: Record<string, string | number> = { 'durable.run_id': execution.runId };
  if (execution.workflow !== undefined) attributes['durable.workflow'] = execution.workflow;
  if (execution.name !== undefined) attributes['durable.step.name'] = execution.name;
  if (execution.seq !== undefined) attributes['durable.step.seq'] = execution.seq;
  if (execution.attempt !== undefined) attributes['durable.step.attempt'] = execution.attempt;
  return attributes;
}

/**
 * Builds the {@link DurableExecutionWrapper} that puts every workflow turn and every step handler
 * body inside a Telescope batch and an OTel span, so the queries, logs and exceptions those bodies
 * produce are correlated to the unit of durable work that caused them instead of landing traceless.
 *
 * ## Why a batch around execution and not around the event
 *
 * The watcher's engine-event subscription records what *happened*, after the fact. A batch opened
 * there would contain exactly one entry — the durable entry itself — and nothing the step actually
 * did, because by then the handler has returned and the exception it threw has long since been
 * recorded with no batch at all. Wrapping the execution is the only shape that puts the failing code
 * inside the scope.
 *
 * ## Nesting: reuse the batch when the same run already has one open on this path
 *
 * With an in-process transport (event-emitter, in-memory, the DB transport's inline path) a
 * dispatched step's handler starts synchronously inside the turn that dispatched it, and the result
 * it produces resumes the next turn on that same async path — so the whole run is one unbroken
 * causal chain. Opening a fresh batch at each hop would split that chain across many batch ids for
 * no gain: Telescope's entry model has no parent-batch pointer, so the split is not recoverable in
 * the UI — the step's queries would appear in a batch with nothing visible causing them.
 *
 * So the rule is the causal one, not the syntactic one: a unit reuses the batch when THIS wrapper
 * already has one open for THIS run on this async path. The consequence is worth stating plainly,
 * because it differs by transport and looks like an inconsistency if you meet it unprepared:
 *
 *  - **in-process transport** — one batch for the whole run (every turn, every step), because it is
 *    genuinely one chain;
 *  - **queue-backed transport** (BullMQ, SQS, a thin worker) — one batch per turn and one per step,
 *    because each really is a separate entry point, in a separate process, with no ambient scope to
 *    inherit.
 *
 * What holds either way is the trace: every entry of a run carries {@link runTraceId}, so the run is
 * one trace whether it executed in one process or twenty. That invariant is the thing to rely on;
 * batch granularity follows the execution shape.
 *
 * A different run is a different chain and always gets its own batch. That includes a child
 * workflow: it has its own run id, its own timeline and its own dashboard row, and its trace is
 * anchored on ITS run id (see {@link runTraceContext}), so it reads as a related-but-distinct trace
 * instead of being folded into the parent's. The parent/child relationship is already carried by the
 * run graph; flattening the batches to restate it would erase the child's own boundaries and gain
 * nothing.
 *
 * ## Origin
 *
 * `BatchOrigin` in `@dudousxd/nestjs-telescope` is the closed union
 * `'http' | 'queue' | 'schedule' | 'cli' | 'manual'` — it has no durable/workflow member. Widening
 * it belongs to that repo and a coordinated release, so this uses `'queue'`, which is also the
 * honest description: durable work reaches an executor by being dispatched over a transport
 * (BullMQ, SQS, an event emitter), exactly like the jobs the BullMQ watcher marks `'queue'`.
 */
export function durableExecutionScope(ctx: WatcherContext): DurableExecutionWrapper {
  const tracer = trace.getTracer('@dudousxd/nestjs-durable-telescope');
  const owner = {};

  return (execution, next) => {
    // Already inside our own scope for this run — reuse it (see "Nesting" above).
    const open = activeScope.getStore();
    if (open?.owner === owner && open.runId === execution.runId) return next();
    // Telescope switched off: `runInBatch` would already short-circuit, but the span and the ALS
    // frame would not, so check here and hand the body straight back.
    if (ctx.config.enabled === false) return next();

    try {
      const parent = runTraceContext(execution.runId);
      const span = tracer.startSpan(
        spanName(execution),
        { attributes: spanAttributes(execution) },
        parent,
      );
      // Prefer the real span's id when an OTel SDK produced one; a host with no SDK gets a
      // non-recording span whose id is the run's synthetic parent, which would make every scope in
      // a run look like one span. Mint an id in that case so the scopes stay distinguishable.
      const spanContext = span.spanContext();
      const scope: DurableScope = {
        runId: execution.runId,
        traceId: runTraceId(execution.runId),
        spanId: span.isRecording() ? spanContext.spanId : randomBytes(8).toString('hex'),
        owner,
      };

      return context.with(trace.setSpan(parent, span), () =>
        activeScope.run(scope, () =>
          ctx.runInBatch(DURABLE_BATCH_ORIGIN, next).then(
            (value) => {
              span.end();
              return value;
            },
            (error: unknown) => {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                ...(error instanceof Error ? { message: error.message } : {}),
              });
              span.end();
              throw error; // never swallow the workflow's error
            },
          ),
        ),
      );
    } catch {
      // Opening the scope failed (a broken tracer, a Telescope in a bad state). Run the work anyway,
      // untraced. The BullMQ and schedule watchers hold the same line from the other direction —
      // they never let a recording failure fail a healthy job — and it matters more here, because
      // this wrapper sits around a workflow body whose failure is durably persisted.
      return next();
    }
  };
}

/** Minimal structural view of Telescope's `TraceContextProvider` (it is one method, and typing
 *  against the interface would drag a value import in for nothing). */
interface TraceContextLike {
  current(): { traceId: string; spanId: string } | null;
}

/**
 * A Telescope `traceContext` provider that reports the active durable scope, so entries recorded by
 * OTHER watchers (queries, cache, outbound HTTP) during a workflow turn or a step body carry the
 * run's trace id.
 *
 * Wire it as `TelescopeModule.forRoot({ traceContext: durableTraceContext() })`.
 *
 * This exists because Telescope resolves an entry's trace id from an ambient OTel span, and
 * `@opentelemetry/api` on its own propagates nothing: without a registered context manager
 * `context.with(...)` is a no-op and `getActiveSpan()` is always undefined. An app that runs a full
 * OTel SDK needs none of this — it should pass `OtelTraceContextProvider` (optionally as the
 * `delegate` below, which is then consulted first so the app's real spans win), and the scope's
 * spans hang off the run's trace anyway. An app that runs no OTel at all — the common case — would
 * otherwise get correlated batches and no trace ids, which is half the feature.
 */
export function durableTraceContext(delegate?: TraceContextLike): TraceContextLike {
  return {
    current() {
      // The host's own tracing wins where it has an answer: inside a durable scope it will report a
      // span from this run's trace anyway, and outside one it is the only source there is.
      const fromDelegate = delegate?.current() ?? null;
      if (fromDelegate) return fromDelegate;
      const scope = activeScope.getStore();
      return scope ? { traceId: scope.traceId, spanId: scope.spanId } : null;
    },
  };
}
