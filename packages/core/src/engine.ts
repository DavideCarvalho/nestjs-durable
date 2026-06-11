import type { RunResult, StateStore, StepOptions, WorkflowCtx, WorkflowRun } from './interfaces';

type WorkflowFn = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

interface RegisteredWorkflow {
  version: string;
  fn: WorkflowFn;
}

export interface WorkflowEngineDeps {
  store: StateStore;
}

/**
 * The orchestrator. Owns workflow state and replays runs deterministically: each step's
 * result is checkpointed, so on resume a completed step returns its saved output instead of
 * re-executing. Remote-step dispatch over a Transport is layered on top (not yet wired here).
 */
export class WorkflowEngine {
  private readonly store: StateStore;
  private readonly workflows = new Map<string, RegisteredWorkflow>();

  constructor(deps: WorkflowEngineDeps) {
    this.store = deps.store;
  }

  register(name: string, version: string, fn: WorkflowFn): void {
    this.workflows.set(name, { version, fn });
  }

  async start(workflow: string, input: unknown, runId: string): Promise<RunResult> {
    const registered = this.requireWorkflow(workflow);
    const now = new Date();
    const run: WorkflowRun = {
      id: runId,
      workflow,
      workflowVersion: registered.version,
      status: 'running',
      input,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);
    return this.execute(run, registered.fn);
  }

  async resume(runId: string): Promise<RunResult> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const registered = this.requireWorkflow(run.workflow);
    return this.execute(run, registered.fn);
  }

  private requireWorkflow(name: string): RegisteredWorkflow {
    const registered = this.workflows.get(name);
    if (!registered) throw new Error(`workflow ${name} is not registered`);
    return registered;
  }

  private async execute(run: WorkflowRun, fn: WorkflowFn): Promise<RunResult> {
    const ctx = this.makeCtx(run.id);
    try {
      const output = await fn(ctx, run.input);
      await this.store.updateRun(run.id, { status: 'completed', output, updatedAt: new Date() });
      return { runId: run.id, status: 'completed', output };
    } catch (err) {
      const error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      await this.store.updateRun(run.id, { status: 'failed', error, updatedAt: new Date() });
      return { runId: run.id, status: 'failed', error };
    }
  }

  private makeCtx(runId: string): WorkflowCtx {
    let seq = -1;
    const store = this.store;
    return {
      runId,
      async step<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T> {
        seq += 1;
        const current = seq;
        const existing = await store.getCheckpoint(runId, current);
        if (existing && existing.status === 'completed') {
          return existing.output as T;
        }
        const maxAttempts = Math.max(1, options?.retries ?? 1);
        const startedAt = new Date();
        for (let attempt = 1; ; attempt += 1) {
          try {
            const output = await fn();
            await store.saveCheckpoint({
              runId,
              seq: current,
              name,
              kind: 'local',
              stepId: `${runId}:${current}`,
              status: 'completed',
              output,
              attempts: attempt,
              startedAt,
              finishedAt: new Date(),
            });
            return output;
          } catch (err) {
            if (attempt >= maxAttempts) throw err;
          }
        }
      },
      async call() {
        throw new Error('remote steps require a Transport (not wired in core engine yet)');
      },
    };
  }
}
