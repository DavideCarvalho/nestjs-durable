import type { RunRedisWorkerOptions, RunningWorker } from '@dudousxd/durable-worker';
import {
  DurableWorkflow,
  type StepInvocation,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { DeadLetter, Step, Workflow } from './decorators';
import { DurableStartClient } from './durable-start-client';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';
import { Entity, On } from './entity';
import { StepInterceptor } from './step-interceptor';

/**
 * A `DurableModule` tenant's `@Workflow` options (item 9), `@DeadLetter` handlers, interceptors and
 * entities (item 10), and `signal`/`signalWithStart`/`publishEvent` (item 11), from the tenant side.
 */

@Workflow({
  name: 'tenant-invoice',
  version: '2',
  tags: ['billing'],
  executionTimeout: '1h',
  input: z.object({ customer: z.string() }),
  singleton: { key: (input) => `customer:${(input as { customer: string }).customer}`, limit: 2 },
  concurrency: { key: () => 'invoices', limit: 5 },
  onEvent: [
    'invoice.requested',
    { event: 'invoice.bulk', input: (p) => ({ customer: String(p) }) },
  ],
})
class InvoiceWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: { customer: string }): Promise<string> {
    return input.customer;
  }

  @DeadLetter()
  async onDead(_ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    return input;
  }
}

@Workflow({ name: 'tenant-plain', version: '1' })
class PlainWorkflow extends DurableWorkflow {
  async run(): Promise<string> {
    return 'ok';
  }
}

@Injectable()
class Steps {
  @Step('tenant-double')
  async double(input: number): Promise<number> {
    return input * 2;
  }
}

const seen: StepInvocation[] = [];

@StepInterceptor()
@Injectable()
class AddOne {
  async intercept(invocation: StepInvocation, next: () => Promise<unknown>): Promise<unknown> {
    seen.push(invocation);
    return ((await next()) as number) + 1;
  }
}

function fakeQueue(sink: { name: string; data: Record<string, unknown> }[]) {
  return class {
    async add(name: string, data: Record<string, unknown>) {
      sink.push({ name, data });
    }
    async close() {}
  };
}

async function bootTenant(extra: Record<string, unknown> = {}, providers: unknown[] = []) {
  const calls: RunRedisWorkerOptions[] = [];
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ connection: 'redis://x', partition: 'acme', ...extra })],
    providers: [InvoiceWorkflow, PlainWorkflow, ...(providers as never[])],
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

describe('a tenant announces its @Workflow options and dead-letter route', () => {
  it('announces tags, executionTimeout and the singleton limit, and its inline @DeadLetter() as <name>.dlq', async () => {
    const { moduleRef, calls } = await bootTenant({ deadLetterWorkflow: 'app-default-dlq' });
    const runtime = calls[0]?.runtime;
    const regs = runtime?.workflowRegistrations() ?? [];
    expect(regs.find((r) => r.name === 'tenant-invoice')).toMatchObject({
      version: '2',
      options: { tags: ['billing'], executionTimeoutMs: 3_600_000, singleton: { limit: 2 } },
      deadLetter: 'tenant-invoice.dlq',
    });
    // The inline handler is served by this worker, so the control plane can start it here.
    expect(regs.find((r) => r.name === 'tenant-invoice.dlq')).toMatchObject({ version: '2' });
    // No option stated, no `options` key; the module-level default is announced as its route.
    const plain = regs.find((r) => r.name === 'tenant-plain');
    expect(plain?.options).toBeUndefined();
    expect(plain?.deadLetter).toBe('app-default-dlq');
    await moduleRef.close();
  });

  it('applies @StepInterceptor providers to the steps the tenant runs', async () => {
    seen.length = 0;
    const { moduleRef, calls } = await bootTenant({}, [Steps, AddOne]);
    const runtime = calls[0]?.runtime;
    const handled = await runtime?.handleTask({
      runId: 'r1',
      seq: 3,
      name: 'tenant-double',
      stepId: 'r1:3',
      group: 'tenant-double@acme',
      input: 20,
      attempt: 1,
    });
    expect(handled).toMatchObject({ kind: 'result', result: { status: 'completed', output: 41 } });
    expect(seen).toEqual([
      { runId: 'r1', workflow: '', stepName: 'tenant-double', seq: 3, attempt: 1 },
    ]);
    await moduleRef.close();
  });

  it('refuses an @Entity provider at boot, saying where it belongs', async () => {
    @Entity({ name: 'cart' })
    @Injectable()
    class Cart {
      items: string[] = [];
      @On('add') add(item: string) {
        this.items.push(item);
      }
    }
    await expect(bootTenant({}, [Cart])).rejects.toThrow(/@Entity cart .*control plane/);
  });
});

describe('a tenant start applies the @Workflow options only it can evaluate', () => {
  async function client() {
    const sink: { name: string; data: Record<string, unknown> }[] = [];
    const { moduleRef } = await bootTenant();
    const real = moduleRef.get(WorkflowEngine) as unknown as DurableStartClient;
    // The same facade, publishing into a fake queue.
    const facade = new DurableStartClient(
      { connection: 'redis://x', partition: 'acme' },
      { Queue: fakeQueue(sink) as never },
    );
    const policies = (real as unknown as { policies: Map<string, unknown> }).policies;
    for (const [name, policy] of policies) facade.declareWorkflow(name, policy as never);
    return { facade, sink, moduleRef };
  }

  it('rejects an input its schema refuses before publishing anything', async () => {
    const { facade, sink, moduleRef } = await client();
    await expect(facade.start('tenant-invoice', { customer: 7 }, 'bad')).rejects.toThrow();
    expect(sink).toEqual([]);
    await moduleRef.close();
  });

  it('carries the evaluated singleton key and the default quota; a per-start quota wins', async () => {
    const { facade, sink, moduleRef } = await client();
    await facade.start('tenant-invoice', { customer: 'c1' }, 'r1');
    expect(sink[0]?.data).toMatchObject({
      singleton: { key: 'customer:c1', limit: 2 },
      concurrency: { key: 'invoices', limit: 5 },
    });
    await facade.start('tenant-invoice', { customer: 'c1' }, 'r2', {
      concurrency: { key: 'vip', limit: 1 },
    });
    expect(sink[1]?.data).toMatchObject({ concurrency: { key: 'vip', limit: 1 } });
    // A workflow with no such options sends none (byte-identical to before).
    await facade.start('tenant-plain', {}, 'r3');
    expect(sink[2]?.data).not.toHaveProperty('singleton');
    expect(sink[2]?.data).not.toHaveProperty('concurrency');
    await moduleRef.close();
  });
});

describe('signal, signalWithStart and publishEvent from a tenant', () => {
  function requests() {
    const sent: unknown[][] = [];
    return {
      sent,
      api: {
        signal: async (...a: unknown[]) => {
          sent.push(['signal', ...a]);
          return { runId: 'w', status: 'pending' as const };
        },
        signalWithStart: async (...a: unknown[]) => {
          sent.push(['signalWithStart', ...a]);
          return { runId: 'counter-1', signalled: true };
        },
        publishEvent: async (...a: unknown[]) => {
          sent.push(['publishEvent', ...a]);
          return 2;
        },
      },
    };
  }

  it('sends them to the control plane as run requests', async () => {
    const sink: { name: string; data: Record<string, unknown> }[] = [];
    const { sent, api } = requests();
    const facade = new DurableStartClient(
      { connection: 'redis://x', partition: 'acme' },
      { Queue: fakeQueue(sink) as never },
      undefined,
      () => api,
    );
    facade.declareWorkflow('tenant-invoice', {
      onEvent: [
        'invoice.requested',
        { event: 'invoice.bulk', where: (p) => p !== 'skip', input: (p) => ({ customer: p }) },
      ],
    });

    expect(await facade.signal('tok', 1, { id: 'd1' })).toEqual({ runId: 'w', status: 'pending' });
    expect(sent[0]).toEqual(['signal', 'tok', 1, { id: 'd1' }]);

    expect(
      await facade.signalWithStart('counter', { n: 0 }, 'counter-1', { token: 'counter-1:add' }),
    ).toEqual({ runId: 'counter-1' });
    expect(sent[1]).toEqual([
      'signalWithStart',
      { workflow: 'counter', input: { n: 0 }, runId: 'counter-1' },
      { token: 'counter-1:add' },
    ]);

    // Its own subscribers start here (where + input applied), the waiting runs resume there.
    expect(await facade.publishEvent('invoice.bulk', 'c9', { id: 'e1' })).toBe(3);
    expect(sink.map((j) => j.data)).toEqual([
      expect.objectContaining({
        workflow: 'tenant-invoice',
        input: { customer: 'c9' },
        runId: 'evt:e1:tenant-invoice',
      }),
    ]);
    expect(sent[2]).toEqual(['publishEvent', 'invoice.bulk', 'c9', { id: 'e1' }]);
    expect(await facade.publishEvent('invoice.bulk', 'skip', { id: 'e2' })).toBe(2);
    expect(sink).toHaveLength(1);
  });

  it('publishEvent: a subscriber that throws is skipped, the others and the resume still happen', async () => {
    const sink: { name: string; data: Record<string, unknown> }[] = [];
    const { sent, api } = requests();
    const facade = new DurableStartClient(
      { connection: 'redis://x', partition: 'acme' },
      { Queue: fakeQueue(sink) as never },
      undefined,
      () => api,
    );
    facade.declareWorkflow('broken', {
      onEvent: [
        {
          event: 'paid',
          input: () => {
            throw new Error('bad mapping');
          },
        },
      ],
    });
    facade.declareWorkflow('fine', { onEvent: ['paid'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await facade.publishEvent('paid', {}, { id: 'e' })).toBe(3);
      expect(sink.map((j) => j.data.workflow)).toEqual(['fine']);
      expect(sent.map((c) => c[0])).toEqual(['publishEvent']);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/broken not started/);
    } finally {
      warn.mockRestore();
    }
  });

  it('without a transport they fail naming what is missing', async () => {
    const facade = new DurableStartClient({ connection: 'redis://x', partition: 'acme' });
    await expect(facade.signal('tok', 1)).rejects.toThrow(/transport/);
    await expect(facade.publishEvent('e', 1)).rejects.toThrow(/transport/);
  });
});
