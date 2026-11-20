import type { RunRedisWorkerOptions, RunningWorker } from '@dudousxd/durable-worker';
import {
  DurableWorkflow,
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DurableStartClient } from './durable-start-client';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';
import { type InferWorkflowInput, Workflow } from './index';

/**
 * With `@Workflow({ input })`, the `singleton` and `concurrency` keys receive the PARSED input, the
 * value `run(ctx, input)` gets, on every path that evaluates them: a local start, a schedule, a
 * tenant start and a tenant's schedule announcement. The schema here coerces `at` to a `Date` and
 * upper-cases `company`, so a key handed the raw input would see a string and a lower-case name.
 */

let parses = 0;
const SyncInput = z.object({
  company: z.string().transform((s) => {
    parses += 1;
    return s.toUpperCase();
  }),
  at: z.coerce.date(),
});

const seen: unknown[] = [];
const ran: unknown[] = [];

function key(input: InferWorkflowInput<typeof SyncInput>): string {
  seen.push(input);
  return `company:${input.company}:${input.at.getUTCFullYear()}`;
}

@Workflow({
  name: 'typed-key-sync',
  input: SyncInput,
  singleton: { key: (input) => key(input) },
  concurrency: { key: (input) => key(input), limit: 10 },
})
class SyncWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: InferWorkflowInput<typeof SyncInput>): Promise<string> {
    ran.push(input);
    return input.company;
  }
}

const RAW = { company: 'acme', at: '2026-11-20T00:00:00.000Z' };
const PARSED = { company: 'ACME', at: new Date(RAW.at) };

function expectParsed(values: unknown[]): void {
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) {
    expect(value).toEqual(PARSED);
    expect((value as { at: unknown }).at).toBeInstanceOf(Date);
  }
}

afterEach(() => {
  parses = 0;
  seen.length = 0;
  ran.length = 0;
});

describe('@Workflow({ input }) keys read the parsed input', () => {
  it('on a local start, the same value run() gets; the run stores the input as sent', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport() })],
      providers: [SyncWorkflow],
    }).compile();
    await moduleRef.init();
    const engine = moduleRef.get(WorkflowEngine);
    await engine.start('typed-key-sync', RAW, 'r1');
    await engine.waitForRun('r1');
    expectParsed(seen);
    expectParsed(ran);
    const run = await store.getRun('r1');
    expect(run?.input).toEqual(RAW);
    expect(run?.tags).toEqual(
      expect.arrayContaining(['singleton:company:ACME:2026', 'concurrency:company:ACME:2026']),
    );
    await moduleRef.close();
  });

  it('on a scheduled start', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          store,
          transport: new InMemoryTransport(),
          timerPollMs: 0,
          schedules: [
            { key: 'sync', workflow: SyncWorkflow, input: RAW as never, everyMs: 60_000 },
          ],
        }),
      ],
      providers: [SyncWorkflow],
    }).compile();
    await moduleRef.init();
    await vi.waitFor(async () => {
      const runs = await store.listRuns({ workflow: 'typed-key-sync' });
      expect(runs[0]?.status).toBe('completed');
    });
    expectParsed(seen);
    await moduleRef.close();
  });
});

async function bootTenant(extra: Record<string, unknown> = {}) {
  const calls: RunRedisWorkerOptions[] = [];
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ connection: 'redis://x', partition: 'acme', ...extra })],
    providers: [SyncWorkflow],
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

describe('a tenant evaluates @Workflow({ input }) keys against the parsed input', () => {
  it('on a start, before publishing it', async () => {
    const sink: { name: string; data: Record<string, unknown> }[] = [];
    const { moduleRef } = await bootTenant();
    const real = moduleRef.get(WorkflowEngine) as unknown as DurableStartClient;
    const facade = new DurableStartClient(
      { connection: 'redis://x', partition: 'acme' },
      {
        Queue: class {
          async add(name: string, data: Record<string, unknown>) {
            sink.push({ name, data });
          }
          async close() {}
        } as never,
      },
    );
    const policies = (real as unknown as { policies: Map<string, unknown> }).policies;
    for (const [name, policy] of policies) facade.declareWorkflow(name, policy as never);
    parses = 0;
    await facade.start('typed-key-sync', RAW, 'r1');
    // Parsed once for validation and both keys.
    expect(parses).toBe(1);
    expect(sink[0]?.data).toMatchObject({
      input: RAW,
      singleton: { key: 'company:ACME:2026' },
      concurrency: { key: 'company:ACME:2026', limit: 10 },
    });
    expectParsed(seen);
    await moduleRef.close();
  });

  it("on a schedule's announced singleton key", async () => {
    const { moduleRef, calls } = await bootTenant({
      schedules: [{ key: 's', workflow: SyncWorkflow, input: RAW, everyMs: 5_000 }],
    });
    expect(calls[0]?.schedules?.items[0]).toMatchObject({
      key: 's',
      workflow: 'typed-key-sync',
      singleton: { key: 'company:ACME:2026' },
    });
    expectParsed(seen);
    await moduleRef.close();
  });
});
