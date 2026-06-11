import {
  type RunQuery,
  type RunResult,
  STATE_STORE,
  type StateStore,
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';

export interface RunDetail {
  run: WorkflowRun;
  /** Steps in execution order — the end-to-end timeline (local + remote). */
  timeline: StepCheckpoint[];
}

/** Read-model and actions backing the control-plane UI. */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(STATE_STORE) private readonly store: StateStore,
    private readonly engine: WorkflowEngine,
  ) {}

  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.store.listRuns(query);
  }

  async getRunDetail(runId: string): Promise<RunDetail | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const timeline = await this.store.listCheckpoints(runId);
    return { run, timeline };
  }

  /** Re-run a failed/incomplete run; completed steps replay from their checkpoints. */
  retry(runId: string): Promise<RunResult> {
    return this.engine.resume(runId);
  }

  cancel(runId: string): Promise<RunResult | null> {
    return this.engine.cancel(runId);
  }
}
