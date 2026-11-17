import type { RunRedisWorkerOptions, RunningWorker } from '@dudousxd/durable-worker';
import {
  ANNOUNCED_SCHEDULE_TAG,
  DurableWorkflow,
  InMemoryStateStore,
  NO_LIVE_WORKER,
  type RemoteTask,
  type StepResult,
  type Transport,
  type WorkerDescriptor,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { Workflow } from './decorators';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';

@Workflow({ name: 'tenant-digest', version: '1' })
class DigestWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: { to: string }): Promise<string> {
    return input.to;
  }
}

/** Boot a tenant (`connection`, no `store`) and capture what its worker is started with. */
async function bootTenant(extra: Record<string, unknown>) {
  const calls: RunRedisWorkerOptions[] = [];
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ connection: 'redis://x', partition: 'acme', ...extra })],
    providers: [DigestWorkflow],
  })
    .overrideProvider(RUN_REDIS_WORKER)
    .useValue(async (opts: RunRedisWorkerOptions): Promise<RunningWorker> => {
      calls.push(opts);
      return { close: async () => {} };
    })
    .compile();
  await moduleRef.init();
  return { moduleRef, calls };
}

describe('a tenant announces its schedules on its worker', () => {
  it('announces each declared schedule under the partition, a class as its workflow name', async () => {
    const { moduleRef, calls } = await bootTenant({
      schedules: [
        { key: 'daily', workflow: DigestWorkflow, input: { to: 'ops' }, cron: '0 8 * * *' },
        { key: 'fast', workflow: 'tenant-digest', everyMs: 5_000, overlap: 'skip', jitter: 100 },
        { key: 'off', workflow: 'tenant-digest', everyMs: 5_000, paused: true, namespace: 'x' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.schedules).toEqual({
      tenant: 'acme',
      items: [
        { key: 'daily', workflow: 'tenant-digest', input: { to: 'ops' }, cron: '0 8 * * *' },
        { key: 'fast', workflow: 'tenant-digest', everyMs: 5_000, overlap: 'skip', jitterMs: 100 },
        // A tenant's runs belong to its own namespace: a schedule's `namespace` is not announced.
        { key: 'off', workflow: 'tenant-digest', everyMs: 5_000, paused: true },
      ],
    });
    await moduleRef.close();
  });

  it('evaluates a singleton workflow key against the schedule input', async () => {
    @Workflow({
      name: 'tenant-single',
      version: '1',
      singleton: { key: (input) => `to:${(input as { to: string }).to}`, maxQueueDepth: 3 },
    })
    class SingleWorkflow extends DurableWorkflow {
      async run(): Promise<null> {
        return null;
      }
    }
    const { moduleRef, calls } = await bootTenant({
      schedules: [{ key: 's', workflow: SingleWorkflow, input: { to: 'ops' }, everyMs: 5_000 }],
    });
    expect(calls[0]?.schedules?.items[0]).toMatchObject({
      key: 's',
      workflow: 'tenant-single',
      singleton: { key: 'to:ops', maxQueueDepth: 3 },
    });
    await moduleRef.close();
  });

  it('states an empty set when it declares none, and presents its tenant token when it has one', async () => {
    const { moduleRef, calls } = await bootTenant({ tenantToken: 'signed-token' });
    expect(calls[0]?.schedules).toEqual({ tenant: 'signed-token', items: [] });
    await moduleRef.close();
  });

  it('a tenant token that fails at boot announces nothing, and the worker still starts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { moduleRef, calls } = await bootTenant({
        tenantToken: () => {
          throw new Error('vault down');
        },
        schedules: [{ key: 'daily', workflow: 'tenant-digest', everyMs: 5_000 }],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.schedules).toBeUndefined();
      expect(warn.mock.calls.flat().join(' ')).toMatch(/vault down/);
      await moduleRef.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns that a producer-only tenant (consumers: false) does not announce them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { moduleRef, calls } = await bootTenant({
        consumers: false,
        schedules: [{ key: 'daily', workflow: 'tenant-digest', everyMs: 5_000 }],
      });
      expect(calls).toHaveLength(0);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/not announced/);
      await moduleRef.close();
    } finally {
      warn.mockRestore();
    }
  });
});

/** A broker fake for the control plane: the live descriptors it reads, and no live worker group. */
class Fleet implements Transport {
  constructor(public descriptors: WorkerDescriptor[]) {}
  async dispatch(_task: RemoteTask): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(): void {}
  async listWorkerGroups(): Promise<string[]> {
    return [];
  }
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    return this.descriptors;
  }
}

const tenantWorker = (everyMs: number): WorkerDescriptor => ({
  instanceId: 'acme-1',
  runtime: 'node',
  sdk: { name: '@dudousxd/durable-worker', version: '0' },
  protocol: { version: 1, range: [1, 1] },
  capabilities: [],
  workflows: ['tenant-digest'],
  steps: [],
  partition: 'acme',
  startedAt: 1,
  schedules: { tenant: 'acme', items: [{ key: 'fast', workflow: 'tenant-digest', everyMs }] },
});

async function bootControlPlane(extra: Record<string, unknown>, fleet: Fleet) {
  const store = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store,
        transport: fleet,
        namespace: undefined,
        timerPollMs: 20,
        ...extra,
      }),
    ],
  }).compile();
  await moduleRef.init();
  return { store, moduleRef, engine: moduleRef.get(WorkflowEngine) };
}

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the control plane adopts and fires what tenants announce', () => {
  it('adopts the schedule and fires its windows as runs waiting for a tenant worker', async () => {
    const fleet = new Fleet([tenantWorker(100)]);
    const { store, moduleRef, engine } = await bootControlPlane(
      { announcedSchedules: { syncMs: 50 } },
      fleet,
    );
    try {
      const adopted = await until(
        () => engine.schedules.get('app:acme:fast'),
        (s) => s !== null,
      );
      expect(adopted).toMatchObject({ namespace: 'acme', announcedKey: 'fast' });
      const runs = await until(
        () => store.listRuns({ tag: ANNOUNCED_SCHEDULE_TAG }),
        (r) => r.length > 0,
      );
      expect(runs[0]).toMatchObject({ status: 'blocked', namespace: 'acme' });
      expect(runs[0]?.error?.code).toBe(NO_LIVE_WORKER);

      // A changed definition is picked up on a later sync.
      fleet.descriptors = [tenantWorker(60_000)];
      const changed = await until(
        () => engine.schedules.get('app:acme:fast'),
        (s) => s?.everyMs === 60_000,
      );
      expect(changed?.everyMs).toBe(60_000);
    } finally {
      await moduleRef.close();
    }
  });

  it('adopts nothing with `announcedSchedules: false`', async () => {
    const { moduleRef, engine } = await bootControlPlane(
      { announcedSchedules: false },
      new Fleet([tenantWorker(100)]),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await engine.schedules.list()).toEqual([]);
    } finally {
      await moduleRef.close();
    }
  });
});
