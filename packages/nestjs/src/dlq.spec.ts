import {
  InMemoryStateStore,
  type StateStore,
  type WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeadLetter, Workflow } from './decorators';
import { DurableModule, type DurableModuleOptions } from './durable.module';

@Workflow({ name: 'poison', version: '1' })
class PoisonWorkflow {
  async run() {
    throw new Error('boom');
  }
}

let dlqInput: DeadLetter | undefined;

@Workflow({ name: 'pipeline-dlq', version: '1' })
class DlqWorkflow {
  async run(_ctx: WorkflowCtx, input: DeadLetter) {
    dlqInput = input;
    return 'handled';
  }
}

/** Seeds a poison run already at the recovery cap, boots the module, and lets recovery dead-letter it. */
async function bootWithDeadRun(
  runId: string,
  workflow: string,
  options: Omit<DurableModuleOptions, 'store'>,
  providers: Provider[],
): Promise<StateStore> {
  const store = new InMemoryStateStore();
  await store.createRun({
    id: runId,
    workflow,
    workflowVersion: '1',
    status: 'running',
    input: { taskId: 't-1' },
    recoveryAttempts: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ store, timerPollMs: 0, maxRecoveryAttempts: 1, ...options })],
    providers,
  }).compile();
  await moduleRef.init(); // bootstrap → recoverIncomplete → run dead → onDead → start the DLQ workflow
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget DLQ start settle
  return store;
}

describe('dead-letter routing', () => {
  beforeEach(() => {
    dlqInput = undefined;
  });

  it('routes to the module-level deadLetterWorkflow default', async () => {
    const store = await bootWithDeadRun('r1', 'poison', { deadLetterWorkflow: 'pipeline-dlq' }, [
      PoisonWorkflow,
      DlqWorkflow,
    ]);

    expect((await store.getRun('r1'))?.status).toBe('dead');
    expect(dlqInput?.deadRunId).toBe('r1');
    expect(dlqInput?.workflow).toBe('poison');
    expect((await store.getRun('dlq:r1'))?.output).toBe('handled');
  });

  it('routes to an inline @DeadLetter() method, co-located on the workflow', async () => {
    let inlineInput: DeadLetter | undefined;

    @Workflow({ name: 'poison-inline', version: '1' })
    class PoisonInlineWorkflow {
      async run() {
        throw new Error('boom');
      }

      @DeadLetter()
      async onDead(_ctx: WorkflowCtx, dead: DeadLetter<{ taskId: string }>) {
        inlineInput = dead;
        return 'inline-handled';
      }
    }

    const store = await bootWithDeadRun('r2', 'poison-inline', {}, [PoisonInlineWorkflow]);

    expect((await store.getRun('r2'))?.status).toBe('dead');
    expect(inlineInput?.deadRunId).toBe('r2');
    expect(inlineInput?.input.taskId).toBe('t-1');
    // The inline handler is auto-registered as `<name>.dlq` and run with a `dlq:<runId>` id.
    expect((await store.getRun('dlq:r2'))?.output).toBe('inline-handled');
  });

  it('routes to a per-workflow @Workflow({ deadLetterWorkflow }) reference', async () => {
    @Workflow({ name: 'poison-ref', version: '1', deadLetterWorkflow: 'pipeline-dlq' })
    class PoisonRefWorkflow {
      async run() {
        throw new Error('boom');
      }
    }

    const store = await bootWithDeadRun('r3', 'poison-ref', {}, [PoisonRefWorkflow, DlqWorkflow]);

    expect(dlqInput?.deadRunId).toBe('r3');
    expect(dlqInput?.workflow).toBe('poison-ref');
    expect((await store.getRun('dlq:r3'))?.output).toBe('handled');
  });

  it('routes via a @Workflow({ deadLetterWorkflow: Class }) class reference', async () => {
    @Workflow({ name: 'poison-classref', version: '1', deadLetterWorkflow: DlqWorkflow })
    class PoisonClassRefWorkflow {
      async run() {
        throw new Error('boom');
      }
    }

    const store = await bootWithDeadRun('r5', 'poison-classref', {}, [
      PoisonClassRefWorkflow,
      DlqWorkflow,
    ]);

    expect(dlqInput?.deadRunId).toBe('r5');
    expect((await store.getRun('dlq:r5'))?.output).toBe('handled');
  });

  it('routes via a module-level deadLetterWorkflow class default', async () => {
    const store = await bootWithDeadRun('r6', 'poison', { deadLetterWorkflow: DlqWorkflow }, [
      PoisonWorkflow,
      DlqWorkflow,
    ]);

    expect(dlqInput?.deadRunId).toBe('r6');
    expect((await store.getRun('dlq:r6'))?.output).toBe('handled');
  });

  it("stamps the dead run's namespace on the DLQ handler run (operator routes it to the tenant)", async () => {
    // A dead run belonging to tenant 't1' — its dead-letter handler must inherit 't1' so an operator
    // dispatches it to the tenant's worker group, not the bare group.
    const store = new InMemoryStateStore();
    await store.createRun({
      id: 'r-ns',
      workflow: 'poison',
      workflowVersion: '1',
      status: 'running',
      input: { taskId: 't-1' },
      namespace: 't1',
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
    await moduleRef.init();
    await new Promise((r) => setImmediate(r));

    expect((await store.getRun('r-ns'))?.status).toBe('dead');
    expect((await store.getRun('dlq:r-ns'))?.namespace).toBe('t1');
  });

  it('rejects a workflow that declares both @DeadLetter() and deadLetterWorkflow', async () => {
    @Workflow({ name: 'poison-both', version: '1', deadLetterWorkflow: 'pipeline-dlq' })
    class PoisonBothWorkflow {
      async run() {
        throw new Error('boom');
      }

      @DeadLetter()
      async onDead(_ctx: WorkflowCtx, _dead: DeadLetter) {
        return 'both';
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store: new InMemoryStateStore(), timerPollMs: 0 })],
      providers: [PoisonBothWorkflow, DlqWorkflow],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(/poison-both/);
  });

  it('prefers the per-workflow handler over the module-level default', async () => {
    let specificInput: DeadLetter | undefined;

    @Workflow({ name: 'poison-specific', version: '1' })
    class PoisonSpecificWorkflow {
      async run() {
        throw new Error('boom');
      }

      @DeadLetter()
      async onDead(_ctx: WorkflowCtx, dead: DeadLetter) {
        specificInput = dead;
        return 'specific-handled';
      }
    }

    // The module default points at `pipeline-dlq`, but the workflow's own inline handler wins.
    const store = await bootWithDeadRun(
      'r4',
      'poison-specific',
      { deadLetterWorkflow: 'pipeline-dlq' },
      [PoisonSpecificWorkflow, DlqWorkflow],
    );

    expect(specificInput?.deadRunId).toBe('r4');
    expect((await store.getRun('dlq:r4'))?.output).toBe('specific-handled');
    expect(dlqInput).toBeUndefined(); // the global default was NOT used
  });
});
