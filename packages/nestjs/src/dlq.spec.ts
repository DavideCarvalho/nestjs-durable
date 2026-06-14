import { InMemoryStateStore, type WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Workflow({ name: 'poison', version: '1' })
class PoisonWorkflow {
  async run() {
    throw new Error('boom');
  }
}

let dlqInput: { deadRunId?: string; workflow?: string } | undefined;

@Workflow({ name: 'pipeline-dlq', version: '1' })
class DlqWorkflow {
  async run(_ctx: WorkflowCtx, input: { deadRunId?: string; workflow?: string }) {
    dlqInput = input;
    return 'handled';
  }
}

describe('deadLetterWorkflow routing', () => {
  it('starts the DLQ workflow with the dead run when a run is dead-lettered', async () => {
    const store = new InMemoryStateStore();
    // A poison run already at the recovery cap, so the next recovery dead-letters it.
    await store.createRun({
      id: 'r1',
      workflow: 'poison',
      workflowVersion: '1',
      status: 'running',
      input: { x: 1 },
      recoveryAttempts: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          timerPollMs: 0,
          maxRecoveryAttempts: 1,
          deadLetterWorkflow: 'pipeline-dlq',
        }),
      ],
      providers: [PoisonWorkflow, DlqWorkflow],
    }).compile();
    await moduleRef.init(); // bootstrap → recoverIncomplete → r1 dead → onDead → start the DLQ workflow
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget DLQ start settle

    expect((await store.getRun('r1'))?.status).toBe('dead');
    expect(dlqInput?.deadRunId).toBe('r1');
    expect(dlqInput?.workflow).toBe('poison');
    expect((await store.getRun('dlq:r1'))?.output).toBe('handled');
  });
});
