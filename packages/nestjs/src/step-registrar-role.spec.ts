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
import { describe, expect, it } from 'vitest';
import { Step, Workflow } from './decorators';
import { DurableModule, type DurableModuleOptions } from './durable.module';
import { IN_APP_RUN_REDIS_WORKER } from './in-app-worker';

// `DurableStepRegistrar` registers `@Step` handlers on the transport only where nothing else
// consumes their queues: a driving operator without a step consumer. A co-located worker serves
// them through its in-app worker runtime, so a second, transport-owned consumer must not start.

@Injectable()
class Probe {
  @Step('probe.run')
  async run(input: unknown) {
    return input;
  }
}

@Workflow({ name: 'probe.flow', version: '1' })
class ProbeFlow {
  constructor(private readonly probe: Probe) {}
  async run(ctx: WorkflowCtx, input: unknown) {
    return ctx.step(this.probe.run, input);
  }
}

/** A transport that runs handlers in-process and carries workflow tasks; records `handle` calls. */
class HandlingTransport implements Transport {
  readonly handled: Array<{ name: string; partition: string | undefined }> = [];
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(_task: WorkflowTask): Promise<void> {}
  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {}
  handle(name: string, _fn: unknown, partition?: string): void {
    this.handled.push({ name, partition });
  }
}

async function handledBy(extra: Partial<DurableModuleOptions>) {
  const transport = new HandlingTransport();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport,
        autoSchema: false,
        timerPollMs: 0,
        ...extra,
      }),
    ],
    providers: [Probe, ProbeFlow],
  })
    .overrideProvider(IN_APP_RUN_REDIS_WORKER)
    .useValue(async () => ({ close: async () => {} }))
    .compile();
  await moduleRef.init();
  await moduleRef.close();
  return transport.handled;
}

describe('DurableStepRegistrar — one consumer per step queue', () => {
  it('registers @Step handlers on the transport for a driving operator with no step consumer', async () => {
    expect(await handledBy({ partition: 'p1' })).toEqual([{ name: 'probe.run', partition: 'p1' }]);
  });

  it('registers none on a co-located worker, whose in-app runtime consumes the step queues', async () => {
    expect(await handledBy({ connection: 'redis://x', partition: 'p1' })).toEqual([]);
  });

  it('registers none on a non-driving operator', async () => {
    expect(await handledBy({ drive: false })).toEqual([]);
  });
});
