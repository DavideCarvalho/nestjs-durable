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
// consumes their queues. A co-located worker whose transport sends steps to per-handler queues
// serves them through its in-app worker runtime, so a second, transport-owned consumer must not
// start; with any other layout the transport's consumer is the only one and stays.

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
  constructor(
    readonly taskQueueLayout?: { queues: 'per-handler' | 'grouped'; drain: boolean } | undefined,
  ) {}
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}
  async dispatchWorkflowTask(_task: WorkflowTask): Promise<void> {}
  onDecision(_handler: (decision: WorkflowDecision) => Promise<void>): void {}
  handle(name: string, _fn: unknown, partition?: string): void {
    this.handled.push({ name, partition });
  }
}

type Layout = ConstructorParameters<typeof HandlingTransport>[0];

async function handledBy(extra: Partial<DurableModuleOptions>, layout?: Layout) {
  const transport = new HandlingTransport(layout);
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
    expect(await handledBy({ partition: 'p1' }, { queues: 'per-handler', drain: false })).toEqual([
      { name: 'probe.run', partition: 'p1' },
    ]);
  });

  const perHandler = { queues: 'per-handler', drain: false } as const;
  const coLocated = { connection: 'redis://x', partition: 'p1' };
  const registered = [{ name: 'probe.run', partition: 'p1' }];

  it('registers none on a co-located worker whose transport uses per-handler step queues', async () => {
    expect(await handledBy(coLocated, perHandler)).toEqual([]);
  });

  it('keeps registering on a co-located worker whose transport uses the grouped layout', async () => {
    // The in-app runtime does not consume `<prefix>-taskgroup`: the transport's consumer is the only one.
    expect(await handledBy(coLocated, { queues: 'grouped', drain: true })).toEqual(registered);
  });

  it('keeps registering on a co-located worker whose per-handler transport drains the grouped layout', async () => {
    expect(await handledBy(coLocated, { queues: 'per-handler', drain: true })).toEqual(registered);
  });

  it('keeps registering on a co-located worker whose transport states no layout', async () => {
    expect(await handledBy(coLocated)).toEqual(registered);
  });

  it('registers none on a non-driving operator', async () => {
    expect(await handledBy({ drive: false })).toEqual([]);
  });
});
