import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowTask,
} from './interfaces';
import { InMemoryStateStore } from './testing/in-memory-state-store';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

/** Broker shared by the operator and a tenant stack whose workers heartbeat ONLY on `@jordi-local`. */
class SharedBroker implements Transport {
  readonly stepGroups: string[] = [];
  readonly workflowGroups: string[] = [];
  private decisionHandler?: (d: WorkflowDecision) => Promise<void>;

  async dispatch(task: RemoteTask): Promise<void> {
    this.stepGroups.push(task.group);
  }
  onResult(_h: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}

  // Exactly what the tenant stack + Python worker subscribe to (report: heartbeats confirm these).
  async listWorkerGroups(): Promise<string[]> {
    return [
      'pipeline@jordi-local',
      'IngestionReadService.runIngestionRead@jordi-local',
      'processing@jordi-local',
    ];
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.workflowGroups.push(task.group);
    const decision: WorkflowDecision = {
      taskId: task.taskId,
      runId: task.runId,
      status: 'completed',
      commands: [],
      output: { ranOnTenantWorker: true },
    };
    setImmediate(() => void this.decisionHandler?.(decision));
  }
  onDecision(h: (d: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = h;
  }
}

describe('REPRO: hybrid operator + tenant stack', () => {
  it('A: global operator WITH local registration runs the body in-process and dispatches the step BARE', async () => {
    const store = new InMemoryStateStore();
    const transport = new SharedBroker();
    // Global operator: topology { role: 'control-plane', tenant: undefined } => namespace undefined.
    const engine = new WorkflowEngine({ store, transport });

    let ranInProcess = false;
    engine.register('pipeline', '1', async (ctx) => {
      ranInProcess = true;
      await ctx.step('IngestionReadService.runIngestionRead', { file: 'x' });
      return 'done';
    });

    await engine.start('pipeline', {}, 'r1', { namespace: 'jordi-local' });
    await poll(async () => transport.stepGroups.length > 0);

    expect((await store.getRun('r1'))?.namespace).toBe('jordi-local');
    // UNCHANGED BY DESIGN: a locally-registered body still runs in-process on the operator. Handing
    // the BODY back to the tenant is a separate, heartbeat-dependent decision we deliberately did not
    // take (it would make placement flap between resumes); the isolation that matters is the work it
    // DISPATCHES, asserted below.
    expect(ranInProcess).toBe(true);
    expect(transport.workflowGroups).toEqual([]);
    // FIXED: the step it dispatches now follows the RUN's tenant, so it lands on the tenant's pool.
    expect(transport.stepGroups).toEqual(['IngestionReadService.runIngestionRead@jordi-local']);
  });

  it('B: control — same operator WITHOUT local registration routes the body to <workflow>@jordi-local', async () => {
    const store = new InMemoryStateStore();
    const transport = new SharedBroker();
    const engine = new WorkflowEngine({ store, transport });

    await engine.start('pipeline', {}, 'r2', { namespace: 'jordi-local' });
    await poll(async () => (await store.getRun('r2'))?.status === 'completed');

    expect(transport.workflowGroups).toEqual(['pipeline@jordi-local']);
  });

  it('C: a TENANT-scoped control plane routes its own steps to its tenant pool', async () => {
    const store = new InMemoryStateStore();
    const transport = new SharedBroker();
    // control-plane with tenant => namespace: 'jordi-local' (partition is forbidden on this role).
    const engine = new WorkflowEngine({ store, transport, namespace: 'jordi-local' });

    engine.register('pipeline', '1', async (ctx) => {
      await ctx.step('IngestionReadService.runIngestionRead', { file: 'x' });
      return 'done';
    });

    await engine.start('pipeline', {}, 'r3');
    await poll(async () => transport.stepGroups.length > 0);

    expect((await store.getRun('r3'))?.namespace).toBe('jordi-local');
    // This is the case the docs always promised (`docs/namespaces.md`) and that never held for steps.
    expect(transport.stepGroups).toEqual(['IngestionReadService.runIngestionRead@jordi-local']);
  });
});
