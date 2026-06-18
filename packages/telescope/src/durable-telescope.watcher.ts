import { type EngineEvent, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';
import { type Span, SpanStatusCode, context, trace } from '@opentelemetry/api';

/**
 * A Telescope watcher that turns durable-workflow lifecycle events into Telescope entries, so
 * runs and steps (including remote/Python steps) show up alongside the app's requests, queries
 * and jobs in the Telescope UI — under the **Workflows** tab.
 *
 * It also **trace-groups** a run: a root span is opened per run and every entry is recorded inside
 * that span's OTel context (step entries inside a child `step …` span). Telescope's trace-context
 * provider stamps each entry with the active span, so a whole workflow shows up as a single trace
 * on the Traces page — run → steps — with each entry carrying the run's `traceId`. When the host has
 * no OTel SDK the spans are no-ops and entries simply carry no trace (the prior behaviour).
 *
 * Add it to `TelescopeModule.forRoot({ watchers: [new DurableTelescopeWatcher()] })`. It resolves
 * the engine from the (global) durable providers and subscribes to its events.
 */
export class DurableTelescopeWatcher implements Watcher {
  readonly type = 'durable';
  /** Open root span per run, so step entries nest under it and share its traceId. */
  private readonly roots = new Map<string, Span>();

  register(ctx: WatcherContext): void {
    const engine = ctx.moduleRef.get(WorkflowEngine, { strict: false });
    const tracer = trace.getTracer('@dudousxd/nestjs-durable-telescope');

    engine.subscribe((event) => {
      const record = () =>
        ctx.record({
          type: this.type,
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

      // Open the run's root span on first sight; later events nest under it.
      if (event.type === 'run.started') {
        this.roots.set(
          event.runId,
          tracer.startSpan(`workflow ${event.workflow ?? '?'}`, {
            attributes: { 'durable.run_id': event.runId, 'durable.workflow': event.workflow },
          }),
        );
      }
      const root = this.roots.get(event.runId);
      const base = root ? trace.setSpan(context.active(), root) : context.active();

      // A step/signal/sleep event → give it its own child span so it's a distinct node in the
      // trace; run-level events record directly on the root. Either way the active span at record
      // time carries the run's traceId, so all entries group into one trace.
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
        context.with(trace.setSpan(base, step), record);
        step.end();
      } else {
        context.with(base, record);
      }

      // Close the run's root span when it leaves the running state.
      if (event.type === 'run.completed' || event.type === 'run.suspended') {
        root?.end();
        this.roots.delete(event.runId);
      } else if (event.type === 'run.failed') {
        const message = event.error?.message;
        root?.setStatus(
          message !== undefined
            ? { code: SpanStatusCode.ERROR, message }
            : { code: SpanStatusCode.ERROR },
        );
        root?.end();
        this.roots.delete(event.runId);
      }
    });
  }

  private tags(event: EngineEvent): string[] {
    const tags = ['durable', event.type, `run:${event.runId}`];
    if (event.workflow) tags.push(`workflow:${event.workflow}`);
    if (event.kind) tags.push(`kind:${event.kind}`);
    if (event.type === 'run.failed') tags.push('failed');
    return tags;
  }
}
