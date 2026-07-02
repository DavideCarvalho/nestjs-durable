import type { EngineEvent, StateStore, TenantEvent } from '@dudousxd/nestjs-durable-core';

/** The narrow slice of `StateStore` the republisher needs — the `step.*`-event namespace fallback
 *  (see {@link TenantEventRepublisher.namespaceFor}). Mirrors the `RunRequestTransport` narrowing
 *  convention (`run-request-responder.ts`): depend on the smallest surface, not the whole store. */
export type RunLookupStore = Pick<StateStore, 'getRun'>;

/** `EngineEvent` types that end a run's lifecycle — no further event for that `runId` will ever
 *  follow one of these, so it is the safe point to drop the run from `TenantEventRepublisher`'s
 *  namespace cache. Matches the terminal members of `EngineEventType` (`packages/core/src/interfaces.ts`)
 *  exactly: `run.suspended` is NOT terminal (a suspended run resumes and emits more events), and
 *  there is no separate `run.cancelled`/`run.dead` event type — both cancellation and dead-lettering
 *  are published as `run.failed`. */
function isTerminalRunEvent(event: EngineEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed';
}

/**
 * Re-publishes engine lifecycle events onto a run's per-tenant channel via `publish` (bound from
 * `Transport.publishTenantEvent`), so a store-less tenant worker can live-tail its OWN runs.
 *
 * The run's namespace is read straight off `event.namespace` (stamped by `engine.ts`'s `emit()` on
 * every `run.*` lifecycle event, where the run is already in hand); a `step.*` event doesn't carry
 * it, so those fall back to one `store.getRun` per unseen run id. Only a GENUINE tenant namespace is
 * memoized in `runNamespaces` — a bare/`default` run (the operator's own unpartitioned runs) never
 * consumes a cache slot, and a run's entry is deleted the moment its terminal event is handled. On
 * an always-on control plane driving every run of every tenant for the process lifetime, this bounds
 * the cache to in-flight tenant runs instead of growing by one entry per run id ever seen.
 */
export class TenantEventRepublisher {
  private readonly runNamespaces = new Map<string, string>();

  constructor(
    private readonly store: RunLookupStore,
    private readonly publish: (event: TenantEvent) => Promise<void>,
  ) {}

  async handle(event: EngineEvent): Promise<void> {
    const namespace = await this.namespaceFor(event);
    // A terminal run emits no further events — drop its cache entry now regardless of whether this
    // event was itself re-published, so the slot is reclaimed even for a bare/default run.
    if (isTerminalRunEvent(event)) this.runNamespaces.delete(event.runId);
    // Skip bare/default runs — no real tenant to re-publish to, and it would just be noise on an
    // unpartitioned operator.
    if (!namespace || namespace === 'default') return;
    await this.publish({ tenant: namespace, event }).catch(() => undefined);
  }

  private async namespaceFor(event: EngineEvent): Promise<string | undefined> {
    if (event.namespace !== undefined) {
      if (event.namespace !== 'default') this.runNamespaces.set(event.runId, event.namespace);
      return event.namespace;
    }
    const cached = this.runNamespaces.get(event.runId);
    if (cached !== undefined) return cached;
    const run = await this.store.getRun(event.runId);
    if (run?.namespace !== undefined && run.namespace !== 'default') {
      this.runNamespaces.set(event.runId, run.namespace);
    }
    return run?.namespace;
  }
}
