import {
  type EngineEvent,
  type RunDetail,
  type RunGateway,
  type RunQuery,
  type RunResult,
  STATE_STORE_CANONICAL,
  type StateStore,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';

/**
 * Store-backed `RunGateway` — the operator-side implementation, bound to {@link RUN_GATEWAY} on
 * worker/drive instances. Reuses `DashboardService`'s six read/control method bodies verbatim
 * (`dashboard.service.ts:76-172`), so a consumer that only needs the bounded `RunGateway` surface
 * (the `RunRequestResponder`, a thin controller) doesn't have to depend on the dashboard package.
 */
@Injectable()
export class StoreRunGateway implements RunGateway {
  constructor(
    @Inject(STATE_STORE_CANONICAL) private readonly store: StateStore,
    private readonly engine: WorkflowEngine,
  ) {}

  async getRunDetail(runId: string): Promise<RunDetail | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const [timeline, children] = await Promise.all([
      this.store.listCheckpoints(runId),
      this.engine.getRunChildren(runId), // canonical parent→children edge (shared with cancel cascade)
    ]);
    return { run, timeline, children };
  }

  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.store.listRuns(query);
  }

  cancel(runId: string): Promise<RunResult | null> {
    return this.engine.cancel(runId);
  }

  /** Re-enqueue (dispatch model) instead of resuming inline — a worker picks the run up and replays it. */
  retry(runId: string): Promise<RunResult | null> {
    return this.engine.requeue(runId);
  }

  continue(runId: string): Promise<RunResult | null> {
    return this.engine.continue(runId);
  }

  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.engine.retryWithInput(runId, input);
  }

  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    return this.engine.subscribe((event) => {
      if (event.runId === runId) onEvent(event);
    });
  }
}
