import type {
  RunQuery,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  WorkflowRun,
} from '../interfaces';

/**
 * A non-durable, in-process `StateStore` for tests and local development.
 * The shipped `@dudousxd/nestjs-durable-store` package re-exports an equivalent.
 */
export class InMemoryStateStore implements StateStore {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly checkpoints = new Map<string, StepCheckpoint>();
  private readonly signalWaiters = new Map<string, SignalWaiter>();

  private key(runId: string, seq: number): string {
    return `${runId}:${seq}`;
  }

  async createRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async updateRun(runId: string, patch: Partial<WorkflowRun>): Promise<void> {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`run ${runId} not found`);
    this.runs.set(runId, { ...existing, ...patch });
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }

  async getCheckpoint(runId: string, seq: number): Promise<StepCheckpoint | null> {
    const cp = this.checkpoints.get(this.key(runId, seq));
    return cp ? { ...cp } : null;
  }

  async saveCheckpoint(checkpoint: StepCheckpoint): Promise<void> {
    this.checkpoints.set(this.key(checkpoint.runId, checkpoint.seq), { ...checkpoint });
  }

  async listIncompleteRuns(): Promise<WorkflowRun[]> {
    return [...this.runs.values()].filter((r) => r.status === 'running').map((r) => ({ ...r }));
  }

  async listDueTimers(nowMs: number): Promise<WorkflowRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.status === 'suspended' && r.wakeAt !== undefined && r.wakeAt <= nowMs)
      .map((r) => ({ ...r }));
  }

  async putSignalWaiter(waiter: SignalWaiter): Promise<void> {
    this.signalWaiters.set(waiter.token, { ...waiter });
  }

  async takeSignalWaiter(token: string): Promise<SignalWaiter | null> {
    const waiter = this.signalWaiters.get(token);
    if (!waiter) return null;
    this.signalWaiters.delete(token);
    return { ...waiter };
  }

  async listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    let runs = [...this.runs.values()];
    if (query.workflow) runs = runs.filter((r) => r.workflow === query.workflow);
    if (query.status) runs = runs.filter((r) => r.status === query.status);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? runs.length;
    return runs.slice(offset, offset + limit).map((r) => ({ ...r }));
  }

  async listCheckpoints(runId: string): Promise<StepCheckpoint[]> {
    return [...this.checkpoints.values()]
      .filter((cp) => cp.runId === runId)
      .sort((a, b) => a.seq - b.seq)
      .map((cp) => ({ ...cp }));
  }
}
