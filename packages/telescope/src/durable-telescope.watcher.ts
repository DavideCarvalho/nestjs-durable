import { type EngineEvent, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import type { Watcher, WatcherContext } from '@dudousxd/nestjs-telescope';

/**
 * A Telescope watcher that turns durable-workflow lifecycle events into Telescope entries, so
 * runs and steps (including remote/Python steps) show up alongside the app's requests, queries
 * and jobs in the Telescope UI.
 *
 * Add it to `TelescopeModule.forRoot({ watchers: [new DurableTelescopeWatcher()] })`. It
 * resolves the engine from the (global) durable providers and subscribes to its events.
 */
export class DurableTelescopeWatcher implements Watcher {
  readonly type = 'durable';

  register(ctx: WatcherContext): void {
    const engine = ctx.moduleRef.get(WorkflowEngine, { strict: false });
    engine.subscribe((event) => {
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
        },
        tags: this.tags(event),
      });
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
