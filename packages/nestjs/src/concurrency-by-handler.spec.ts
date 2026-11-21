import { type RunnerDeps, runRedisWorker } from '@dudousxd/durable-worker';
import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowCtx,
  WorkflowDecision,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { Step, Workflow } from './decorators';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import { IN_APP_RUN_REDIS_WORKER, type RunRedisWorkerFn } from './in-app-worker';

// `concurrencyByHandler` on `DurableModule.forRoot` reaches the BullMQ Worker of each named queue,
// on both worker roles. These specs drive the REAL `runRedisWorker` with a faked bullmq surface, so
// what is asserted is the concurrency each per-name Worker was constructed with.

@Workflow({ name: 'ask.run', version: '1' })
class AskWorkflow {
  async run(_ctx: WorkflowCtx, input: unknown) {
    return input;
  }
}

@Workflow({ name: 'digest', version: '1' })
class DigestWorkflow {
  async run(_ctx: WorkflowCtx, input: unknown) {
    return input;
  }
}

@Injectable()
class Pages {
  @Step('pages.extract')
  async extract(input: unknown) {
    return input;
  }
}

class WorkflowTaskTransport implements Transport {
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(_task: WorkflowTask): Promise<void> {}
  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {}
}

/** The real runner over a bullmq fake that records each Worker's queue and constructor options. */
function realRunnerOverFakeBullmq() {
  const workers: Array<{ queue: string; concurrency: unknown }> = [];
  const deps: RunnerDeps = {
    Worker: class {
      constructor(queue: string, _proc: unknown, opts: Record<string, unknown>) {
        workers.push({ queue, concurrency: opts.concurrency });
      }
      async close() {}
    },
    Queue: class {
      async add() {}
      async close() {}
    },
  };
  const run: RunRedisWorkerFn = (opts) => runRedisWorker({ ...opts, deps });
  return {
    run,
    byQueue: () => Object.fromEntries(workers.map((w) => [w.queue, w.concurrency])),
  };
}

const coLocated = (extra: Partial<DurableModuleOptions>): DurableModuleOptions => ({
  store: new InMemoryStateStore(),
  transport: new WorkflowTaskTransport(),
  autoSchema: false,
  connection: 'redis://x',
  ...extra,
});
const thin = (extra: Partial<DurableModuleOptions>): DurableModuleOptions => ({
  connection: 'redis://x',
  ...extra,
});

const roles = [
  {
    role: 'co-located worker (store + connection)',
    options: coLocated,
    token: IN_APP_RUN_REDIS_WORKER,
  },
  { role: 'thin worker (connection only)', options: thin, token: RUN_REDIS_WORKER },
] as const;

describe.each(roles)('concurrencyByHandler on a $role', ({ role, options, token }) => {
  async function boot(extra: Partial<DurableModuleOptions>) {
    const runner = realRunnerOverFakeBullmq();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot(options(extra))],
      providers: [AskWorkflow, DigestWorkflow, Pages],
    })
      .overrideProvider(token)
      .useValue(runner.run)
      .compile();
    await moduleRef.init();
    return { runner, moduleRef };
  }

  it('keeps every queue at concurrency 1 when neither option is set', async () => {
    const { runner, moduleRef } = await boot({});
    expect(runner.byQueue()).toEqual({
      'durable-tasks-ask.run': 1,
      'durable-tasks-digest': 1,
      'durable-tasks-pages.extract': 1,
    });
    await moduleRef.close();
  });

  it('gives each named workflow and step its own Worker concurrency', async () => {
    const { runner, moduleRef } = await boot({
      partition: 'acme',
      concurrency: 1,
      concurrencyByHandler: { 'ask.run': 4, 'pages.extract': 2 },
    });
    expect(runner.byQueue()).toEqual({
      'durable-tasks-ask.run@acme': 4,
      'durable-tasks-digest@acme': 1,
      'durable-tasks-pages.extract@acme': 2,
    });
    await moduleRef.close();
  });

  it('warns about a name no handler registers and still boots', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The warning is once per name per process, so each role gets a name of its own.
    const missing = `gone.${role.split(' ')[0]}`;
    const { runner, moduleRef } = await boot({ concurrencyByHandler: { [missing]: 8 } });
    expect(Object.values(runner.byQueue())).toEqual([1, 1, 1]);
    expect(warn.mock.calls.flat().join(' ')).toContain(
      `not registered by this process, ignored: ${missing}`,
    );
    warn.mockRestore();
    await moduleRef.close();
  });
});
