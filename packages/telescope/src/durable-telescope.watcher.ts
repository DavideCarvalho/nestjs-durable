import {
  type EngineEvent,
  WorkflowEngine,
  useDurableExecution,
} from '@dudousxd/nestjs-durable-core';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { durableExecutionScope } from './durable-execution-scope';
import { runTraceContext, runTraceId } from './durable-run-trace';

/**
 * A Telescope watcher that turns durable-workflow lifecycle events into Telescope entries, so
 * runs and steps (including remote/Python steps) show up alongside the app's requests, queries
 * and jobs in the Telescope UI — under the **Workflows** tab.
 *
 * It does two things, and the second is the one that makes a failing workflow debuggable:
 *
 * 1. **Records an entry per engine event**, stamped with the run's trace (see
 *    {@link runTraceContext}), so a whole run — across all its turns, all its steps and every
 *    process that executed them — reads as a single trace at `/telescope#/traces/<id>`.
 *
 * 2. **Opens a Telescope batch around the execution itself** (see {@link durableExecutionScope}),
 *    through the engine's `useDurableExecution` seam. Without this, everything a workflow turn or a
 *    step handler *did* — its queries, its logs, the exception it threw — was recorded outside any
 *    batch and outside any span: traceless, and so impossible to correlate back to the step that
 *    caused it. Recording an event after the fact cannot fix that; the scope has to be open while
 *    the body runs.
 *
 * Add it to `TelescopeModule.forRoot({ watchers: [new DurableTelescopeWatcher()] })`. It resolves
 * the engine from the (global) durable providers and subscribes to its events.
 *
 * ## What is NOT covered
 *
 * A **remote step** — one whose handler lives in another runtime, e.g. the Python worker — executes
 * out of process, so nothing here can wrap it. Its lifecycle still shows up (the engine emits
 * `step.started`/`step.completed`/`step.failed` when it dispatches and when the result lands, and
 * those entries carry the run's trace id), but the queries and exceptions *inside* that handler are
 * that runtime's to record. Because the trace id is derived from the run id rather than held in this
 * process, a remote runtime that derives it the same way joins the same trace — but that is a change
 * on its side, not something this watcher can do on its behalf.
 *
 * A **remote workflow** (a run whose body itself lives in another runtime) is likewise unwrapped:
 * the engine dispatches a workflow task and awaits a decision rather than executing a body, and a
 * scope around a dispatch would describe the wrong thing.
 */
export class DurableTelescopeWatcher implements Watcher {
  readonly type = 'durable';
  /** Removes the execution wrapper from the engine's process-level registry. */
  private disposeScope: (() => void) | undefined;

  register(ctx: WatcherContext): void {
    // Registered FIRST, and unconditionally: this is the half that works without a local engine. A
    // thin worker binds `WorkflowEngine` to a start-only facade with no event stream, but it is
    // exactly where step handlers run — so the execution scope belongs there even though there is
    // nothing local to subscribe to.
    this.disposeScope?.();
    this.disposeScope = useDurableExecution(durableExecutionScope(ctx));

    const engine = ctx.moduleRef.get(WorkflowEngine, { strict: false });
    // A store-less thin-worker / tenant deployment (e.g. a local `DURABLE_TENANT=…` dev stack) binds
    // the `WorkflowEngine` token to a start-only `DurableStartClient` facade — it proxies run starts
    // over the transport and has NO local lifecycle event stream (those events live on the operator
    // that holds the store). There's nothing local to observe, so skip the subscription gracefully
    // instead of throwing "engine.subscribe is not a function".
    if (typeof (engine as Partial<WorkflowEngine>)?.subscribe !== 'function') return;
    const tracer = trace.getTracer('@dudousxd/nestjs-durable-telescope');

    engine.subscribe((event) => {
      const record = () =>
        ctx.record({
          type: this.type,
          // Stated explicitly rather than left to the ambient span, and the Recorder honours an
          // explicit `traceId` above everything else. A lifecycle event is very often emitted
          // OUTSIDE any execution scope — a remote step's result lands in a transport callback, a
          // recovery sweep emits for a run this process never executed — and those entries are
          // exactly the ones an operator follows into the trace. We know the run, so we know the
          // trace; there is no reason to let it depend on where the emit happened to land.
          traceId: runTraceId(event.runId),
          content: {
            event: event.type,
            workflow: event.workflow,
            runId: event.runId,
            seq: event.seq,
            name: event.name,
            kind: event.kind,
            output: event.output,
            error: event.error,
            durationMs: event.durationMs,
          },
          tags: this.tags(event),
        });

      // Anchor on the run's trace. Derived from the run id, so this event groups with the entries
      // recorded *inside* the turn/step scopes without either side having to hand the other a span —
      // which is the only thing that works once a step executes on a later turn, or in another pod.
      const base = runTraceContext(event.runId);

      // A step/signal/sleep event → give it its own child span so it's a distinct node in the
      // trace; run-level events record against the run's own span context. Either way the active
      // span at record time carries the run's trace id, so all entries group into one trace.
      if (event.name != null && event.seq != null) {
        const step = tracer.startSpan(
          `step ${event.name}`,
          {
            attributes: {
              'durable.run_id': event.runId,
              'durable.step.seq': event.seq,
              'durable.step.kind': event.kind,
            },
          },
          base,
        );
        if (event.type === 'step.failed') {
          const message = event.error?.message;
          step.setStatus(
            message !== undefined
              ? { code: SpanStatusCode.ERROR, message }
              : { code: SpanStatusCode.ERROR },
          );
        }
        context.with(trace.setSpan(base, step), record);
        step.end();
      } else {
        context.with(base, record);
      }
    });
  }

  /**
   * Detach the execution wrapper. The `Watcher` SPI has no teardown hook, so nothing calls this in a
   * running app — where the wrapper should live exactly as long as the process does. It exists so a
   * test that registers a watcher does not leave a wrapper behind in the process-level registry for
   * the next test to trip over.
   */
  unregister(): void {
    this.disposeScope?.();
    this.disposeScope = undefined;
  }

  private tags(event: EngineEvent): string[] {
    const tags = ['durable', event.type, `run:${event.runId}`];
    if (event.workflow) tags.push(`workflow:${event.workflow}`);
    if (event.kind) tags.push(`kind:${event.kind}`);
    if (event.type === 'run.failed') tags.push('failed');
    return tags;
  }
}
