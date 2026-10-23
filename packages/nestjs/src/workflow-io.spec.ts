import 'reflect-metadata';
import {
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsString } from 'class-validator';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Workflow, getWorkflowMeta } from './decorators';
import { DurableModule } from './durable.module';
import { registerOnRuntime } from './runtime-registration';
import { WorkflowService } from './workflow.service';

// What each turn's body saw, so a test can compare the first execution with the replay.
const seen: unknown[] = [];

const zodInput = z.object({ orderId: z.string(), placedAt: z.coerce.date() });

@Workflow({ name: 'zod-io', input: zodInput, output: z.object({ total: z.coerce.number() }) })
class ZodIoWorkflow {
  async run(ctx: WorkflowCtx, input: z.infer<typeof zodInput>) {
    seen.push(input.placedAt);
    const { amount } = await ctx.waitForSignal<{ amount: string }>(`pay:${input.orderId}`);
    return { total: amount };
  }
}

class OrderDto {
  @IsString() orderId!: string;
  @Type(() => Date) @IsDate() placedAt!: Date;
  describe(): string {
    return `order ${this.orderId}`;
  }
}

@Workflow({ name: 'dto-io', input: OrderDto })
class DtoIoWorkflow {
  async run(_ctx: WorkflowCtx, input: OrderDto) {
    seen.push(input);
    return input.describe();
  }
}

class LegacyDto {
  @IsInt() total!: number;
}

@Workflow({ name: 'legacy-io', inputSchema: LegacyDto })
class LegacyIoWorkflow {
  async run() {
    return 'ok';
  }
}

@Workflow({
  name: 'checked-io',
  input: z.object({ from: z.string(), to: z.string() }),
  validateInput: (input) => {
    const { from, to } = input as { from: string; to: string };
    if (from === to) throw new Error('cannot transfer to the same account');
  },
})
class CheckedIoWorkflow {
  async run() {
    return 'ok';
  }
}

@Workflow({
  name: 'checked-parsed',
  input: z.object({ placedAt: z.coerce.date() }),
  validateInput: (input) => {
    seen.push((input as { placedAt: unknown }).placedAt);
  },
})
class CheckedParsedWorkflow {
  async run() {
    return 'ok';
  }
}

@Workflow({ name: 'bad-output', output: z.object({ id: z.string() }) })
class BadOutputWorkflow {
  async run() {
    return { id: 42 };
  }
}

async function boot(store = new InMemoryStateStore()) {
  const mod = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 })],
    providers: [
      ZodIoWorkflow,
      DtoIoWorkflow,
      LegacyIoWorkflow,
      CheckedIoWorkflow,
      CheckedParsedWorkflow,
      BadOutputWorkflow,
    ],
  }).compile();
  await mod.init();
  return { mod, store, svc: mod.get(WorkflowService) };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  seen.length = 0;
  await close?.();
  close = undefined;
});

describe('@Workflow({ input, output })', () => {
  it('stores the input as sent, and hands every turn — the replay too — the parsed value', async () => {
    const { mod, store, svc } = await boot();
    close = () => mod.close();

    await svc.start('zod-io', { orderId: 'o1', placedAt: '2026-01-02T03:04:05.000Z' }, 'r1');
    expect((await svc.waitForRun('r1')).status).toBe('suspended');
    await svc.signal('pay:o1', { amount: '12.5' });
    const result = await svc.waitForRun('r1');

    expect(result.status).toBe('completed');
    // The stored row keeps what the caller sent; the output is the parsed (coerced) value.
    const run = await store.getRun('r1');
    expect(run?.input).toEqual({ orderId: 'o1', placedAt: '2026-01-02T03:04:05.000Z' });
    expect(run?.output).toEqual({ total: 12.5 });
    // Two turns (first execution + replay after the signal), each with a real Date.
    expect(seen).toHaveLength(2);
    for (const placedAt of seen) {
      expect(placedAt).toBeInstanceOf(Date);
      expect((placedAt as Date).toISOString()).toBe('2026-01-02T03:04:05.000Z');
    }
  });

  it('rejects invalid input at start, before creating the run, with the issues attached', async () => {
    const { mod, store, svc } = await boot();
    close = () => mod.close();

    const error = await svc
      .start('zod-io', { orderId: 7, placedAt: 'nope' }, 'bad')
      .catch((e) => e);

    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(error.message).toMatch(/^invalid workflow "zod-io" input: orderId: /);
    expect(error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['orderId'] })]),
    );
    expect(await store.getRun('bad')).toBeNull();
  });

  it('fails a run whose stored input no longer parses with code invalid_input', async () => {
    const { mod, store, svc } = await boot();
    close = () => mod.close();

    await svc.start('zod-io', { orderId: 'o2', placedAt: '2026-01-02T03:04:05.000Z' }, 'r2');
    await svc.waitForRun('r2');
    // As if the schema had changed under an in-flight run without a version bump.
    await store.updateRun('r2', { input: { orderId: 'o2', placedAt: 'not a date' } });
    await svc.signal('pay:o2', { amount: '1' });
    const result = await svc.waitForRun('r2');

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'invalid_input' });
  });

  it('hands a class-validator DTO body a real instance of the DTO', async () => {
    const { mod, svc } = await boot();
    close = () => mod.close();

    await svc.start('dto-io', { orderId: 'o3', placedAt: '2026-01-02T03:04:05.000Z' }, 'r3');
    const result = await svc.waitForRun('r3');

    expect(result).toMatchObject({ status: 'completed', output: 'order o3' });
    expect(seen[0]).toBeInstanceOf(OrderDto);
    expect((seen[0] as OrderDto).placedAt).toBeInstanceOf(Date);
  });

  it('rejects a non-object input to a DTO schema on the same invalid_input contract', async () => {
    const { mod, store, svc } = await boot();
    close = () => mod.close();

    for (const [input, got] of [
      [null, 'null'],
      ['x', 'string'],
      [[], 'an array'],
    ] as const) {
      await expect(svc.start('dto-io', input, 'bad')).rejects.toMatchObject({
        code: 'invalid_input',
        message: `invalid workflow "dto-io" input: expected an object, got ${got}`,
      });
    }
    expect(await store.getRun('bad')).toBeNull();
  });

  it('keeps inputSchema working as an alias of input', async () => {
    const { mod, store, svc } = await boot();
    close = () => mod.close();

    await expect(svc.start('legacy-io', { total: 'oops' }, 'bad')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(await store.getRun('bad')).toBeNull();
    await svc.start('legacy-io', { total: 5 }, 'good');
    expect((await svc.waitForRun('good')).status).toBe('completed');
  });

  it('runs validateInput after the schema parses', async () => {
    const { mod, store, svc } = await boot();
    close = () => mod.close();

    await expect(svc.start('checked-io', { from: 'a' }, 'r4')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(svc.start('checked-io', { from: 'a', to: 'a' }, 'r5')).rejects.toThrow(
      'cannot transfer to the same account',
    );
    expect(await store.getRun('r4')).toBeNull();
    expect(await store.getRun('r5')).toBeNull();
  });

  it('hands validateInput the parsed value, while the run stores the input as sent', async () => {
    const { mod, store, svc } = await boot();
    close = () => mod.close();

    await svc.start('checked-parsed', { placedAt: '2026-01-02T03:04:05.000Z' }, 'r7');

    expect(seen[0]).toBeInstanceOf(Date);
    expect((await store.getRun('r7'))?.input).toEqual({ placedAt: '2026-01-02T03:04:05.000Z' });
  });

  it('fails a run whose output does not match the output schema with code invalid_output', async () => {
    const { mod, svc } = await boot();
    close = () => mod.close();

    await svc.start('bad-output', {}, 'r6');
    const result = await svc.waitForRun('r6');

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'invalid_output' });
  });

  it('refuses input and inputSchema together', () => {
    expect(() =>
      Workflow({ name: 'both', input: zodInput, inputSchema: LegacyDto })(class {}),
    ).toThrow('set either `input` or its alias `inputSchema`, not both');
  });

  it('parses around the body a worker runtime registers too', async () => {
    const bodies = new Map<string, (ctx: WorkflowCtx, input: unknown) => Promise<unknown>>();
    const runtime = {
      registerWorkflow: (
        name: string,
        fn: (ctx: WorkflowCtx, input: unknown) => Promise<unknown>,
      ) => bodies.set(name, fn),
    };
    const meta = getWorkflowMeta(ZodIoWorkflow);
    if (!meta) throw new Error('ZodIoWorkflow carries no @Workflow metadata');
    registerOnRuntime(
      runtime as never,
      { getAllMethodNames: () => [] } as never,
      meta,
      new ZodIoWorkflow(),
      undefined,
    );
    const ctx = {
      waitForSignal: async () => ({ amount: '3' }),
    } as unknown as WorkflowCtx;

    const body = bodies.get('zod-io');
    if (!body) throw new Error('zod-io was not registered on the runtime');
    const output = await body(ctx, {
      orderId: 'o4',
      placedAt: '2026-01-02T03:04:05.000Z',
    });

    expect(seen[0]).toBeInstanceOf(Date);
    expect(output).toEqual({ total: 3 });
  });
});
