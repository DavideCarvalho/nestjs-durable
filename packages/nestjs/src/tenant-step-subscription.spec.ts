import {
  type Heartbeat,
  InMemoryStateStore,
  type RemoteTask,
  type StepLogger,
  type StepResult,
  type Transport,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Step, Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Injectable()
class IngestionReadService {
  @Step()
  async runIngestionRead(): Promise<string> {
    return 'read';
  }
}

@Workflow({ name: 'pipeline' })
class PipelineWorkflow {
  async run(): Promise<string> {
    return 'ok';
  }
}

/** Records the partition each `@Step` handler is registered to serve. */
class HandleRecordingTransport implements Transport {
  readonly handled: Array<{ name: string; partition?: string | undefined }> = [];
  async dispatch(_t: RemoteTask): Promise<void> {}
  onResult(_h: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
  handle(
    name: string,
    _fn: (input: unknown, log: StepLogger) => unknown,
    partition?: string | undefined,
  ): void {
    this.handled.push({ name, partition });
  }
}

/**
 * A control plane scoped to a tenant DISPATCHES its steps to `<name>@<tenant>` (core's `stepGroup`).
 * Its in-process `@Step` handlers must be registered to SERVE that same suffixed token — otherwise the
 * node enqueues work onto a queue nobody in it consumes, and every run hangs.
 */
describe('in-process @Step handlers serve the control plane tenant partition', () => {
  it("{ role: 'control-plane', tenant } registers its @Step on the tenant partition", async () => {
    const transport = new HandleRecordingTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          topology: { role: 'control-plane', tenant: 'davi-local' },
          store: new InMemoryStateStore(),
          transport,
          timerPollMs: 0,
        }),
      ],
      providers: [IngestionReadService, PipelineWorkflow],
    }).compile();
    await moduleRef.init();

    expect(transport.handled).toContainEqual({
      name: 'IngestionReadService.runIngestionRead',
      partition: 'davi-local',
    });

    await moduleRef.close();
  });

  it('a global operator (no tenant) still registers its @Step on the BARE token', async () => {
    const transport = new HandleRecordingTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          topology: { role: 'control-plane' },
          store: new InMemoryStateStore(),
          transport,
          timerPollMs: 0,
        }),
      ],
      providers: [IngestionReadService, PipelineWorkflow],
    }).compile();
    await moduleRef.init();

    expect(transport.handled).toContainEqual({
      name: 'IngestionReadService.runIngestionRead',
      partition: undefined,
    });

    await moduleRef.close();
  });

  // The `docs/namespaces.md` local-dev recipe: a namespaced engine with no `topology` preset. Its runs
  // are stamped `dev-alice` and now dispatch to `<name>@dev-alice`, so its own handlers must serve
  // that token — otherwise the documented setup silently enqueues into queues nobody consumes.
  it('a bare `namespace` (no topology preset) also serves its own tenant partition', async () => {
    const transport = new HandleRecordingTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport,
          namespace: 'dev-alice',
          timerPollMs: 0,
        }),
      ],
      providers: [IngestionReadService, PipelineWorkflow],
    }).compile();
    await moduleRef.init();

    expect(transport.handled).toContainEqual({
      name: 'IngestionReadService.runIngestionRead',
      partition: 'dev-alice',
    });

    await moduleRef.close();
  });

  it('an explicit `partition` still wins over the namespace', async () => {
    const transport = new HandleRecordingTransport();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store: new InMemoryStateStore(),
          transport,
          namespace: 'dev-alice',
          partition: 'gpu-pool',
          timerPollMs: 0,
        }),
      ],
      providers: [IngestionReadService, PipelineWorkflow],
    }).compile();
    await moduleRef.init();

    expect(transport.handled).toContainEqual({
      name: 'IngestionReadService.runIngestionRead',
      partition: 'gpu-pool',
    });

    await moduleRef.close();
  });
});
