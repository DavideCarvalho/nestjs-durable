import type {
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';
import { IN_APP_RUN_REDIS_WORKER, type RunRedisWorkerFn } from './in-app-worker';

// `consumers: false` makes a process that boots the module — a CLI command, a REPL, a script — a pure
// producer: the transports' point-to-point consumers stay parked and no co-located/thin worker
// consumer starts, so it never competes with the real fleet for jobs.

/** Records the order of deferral vs consumer registration. */
class DeferrableTransport implements Transport {
  readonly log: string[] = [];
  deferConsumers(): void {
    this.log.push('defer');
  }
  startConsumers(): void {
    this.log.push('start');
  }
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {
    this.log.push('onResult');
  }
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(_task: WorkflowTask): Promise<void> {}
  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.log.push('onDecision');
  }
}

function countingRunner(): { calls: number; fn: RunRedisWorkerFn } {
  const state = { calls: 0, fn: (async () => ({ close: async () => {} })) as RunRedisWorkerFn };
  state.fn = async () => {
    state.calls += 1;
    return { close: async () => {} };
  };
  return state;
}

describe('DurableModule `consumers: false`', () => {
  it('defers every transport consumer before the engine subscribes', async () => {
    const transport = new DeferrableTransport();
    const pooled = new DeferrableTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transports: [
            { id: 'a', transport },
            { id: 'b', transport: pooled },
          ],
          autoSchema: false,
          consumers: false,
        }),
      ],
    }).compile();
    await moduleRef.init();
    expect(transport.log[0]).toBe('defer');
    expect(transport.log).toContain('onResult');
    expect(pooled.log[0]).toBe('defer');
    expect(transport.log).not.toContain('start');
    await moduleRef.close();
  });

  it('leaves consumers alone by default', async () => {
    const transport = new DeferrableTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store: new InMemoryStateStore(), transport, autoSchema: false }),
      ],
    }).compile();
    await moduleRef.init();
    expect(transport.log).not.toContain('defer');
    await moduleRef.close();
  });

  it('does not start the co-located worker consumer', async () => {
    const runner = countingRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport: new DeferrableTransport(),
          autoSchema: false,
          connection: 'redis://x',
          consumers: false,
        }),
      ],
    })
      .overrideProvider(IN_APP_RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .compile();
    await moduleRef.init();
    expect(runner.calls).toBe(0);
    await moduleRef.close();
  });

  it('does not start the thin worker consumer', async () => {
    const runner = countingRunner();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ connection: 'redis://x', consumers: false })],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.fn)
      .compile();
    await moduleRef.init();
    expect(runner.calls).toBe(0);
    await moduleRef.close();
  });
});
