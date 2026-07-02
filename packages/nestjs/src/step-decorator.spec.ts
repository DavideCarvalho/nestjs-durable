import 'reflect-metadata';
import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  InMemoryStateStore,
  type StepConfig,
  type WorkflowCtx,
  stepConfigOf,
} from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DURABLE_STEP_METADATA, Step, Workflow, getDurableStepMeta } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

// ---------------------------------------------------------------------------
// Unit: `@Step` name derivation, override, and the cross-package DURABLE_STEP_NAME stamp.
// (`@Step` end-to-end dispatch + serve is covered by `durable-step.spec.ts`.)
// ---------------------------------------------------------------------------

describe('@Step() bare — name derivation', () => {
  it('derives the routing name as `Class.method`', () => {
    class ExtractionService {
      @Step()
      runExtractionPage(_input: { page: number }) {
        return { records: [] };
      }
    }

    const meta = getDurableStepMeta(ExtractionService.prototype.runExtractionPage);
    expect(meta).toEqual({ name: 'ExtractionService.runExtractionPage' });
  });

  it('stamps the SAME resolved name under the shared DURABLE_STEP_NAME symbol (core reads it back via stepNameOf)', () => {
    class Svc {
      @Step()
      doWork(_input: unknown) {
        return null;
      }
    }

    const stamped = (Svc.prototype.doWork as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME];
    expect(stamped).toBe('Svc.doWork');
  });
});

describe("@Step('custom:name') — explicit string override", () => {
  it('uses the given name instead of the derived one', () => {
    class Svc {
      @Step('payments:charge-card')
      charge(_input: unknown) {
        return null;
      }
    }

    expect(getDurableStepMeta(Svc.prototype.charge)).toEqual({ name: 'payments:charge-card' });
    const stamped = (Svc.prototype.charge as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME];
    expect(stamped).toBe('payments:charge-card');
  });
});

describe('@Step({ name?, input?, output? }) — object form', () => {
  it('derives the name and attaches input/output schemas when name is omitted', () => {
    const input = z.object({ amount: z.number() });
    const output = z.object({ chargeId: z.string() });

    class Svc {
      @Step({ input, output })
      charge(_input: unknown) {
        return null;
      }
    }

    const meta = getDurableStepMeta(Svc.prototype.charge);
    expect(meta?.name).toBe('Svc.charge');
    expect(meta?.input).toBe(input);
    expect(meta?.output).toBe(output);
    const stamped = (Svc.prototype.charge as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME];
    expect(stamped).toBe('Svc.charge');
  });

  it('overrides the name too, when given', () => {
    const input = z.object({ amount: z.number() });

    class Svc {
      @Step({ name: 'payments:charge', input })
      charge(_input: unknown) {
        return null;
      }
    }

    const meta = getDurableStepMeta(Svc.prototype.charge);
    expect(meta).toEqual({ name: 'payments:charge', input });
  });

  it('a bare @Step({}) carries no schemas (validation stays opt-in)', () => {
    class Svc {
      @Step({})
      noop(_input: unknown) {
        return null;
      }
    }

    const meta = getDurableStepMeta(Svc.prototype.noop);
    expect(meta?.input).toBeUndefined();
    expect(meta?.output).toBeUndefined();
  });
});

describe('@Step({ retries, backoff, backoffMs, backoffMaxMs, jitter, timeoutMs }) — dispatch policy', () => {
  it('stamps the policy under DURABLE_STEP_CONFIG, readable via stepConfigOf', () => {
    class Svc {
      @Step({ retries: 3, backoff: 'exp', backoffMs: 100, backoffMaxMs: 5000, timeoutMs: 30_000 })
      charge(_input: unknown) {
        return null;
      }
    }

    const config = stepConfigOf(Svc.prototype.charge);
    expect(config).toEqual({
      retries: 3,
      backoff: 'exp',
      backoffMs: 100,
      backoffMaxMs: 5000,
      timeoutMs: 30_000,
    });
    const stamped = (Svc.prototype.charge as { [DURABLE_STEP_CONFIG]?: StepConfig })[
      DURABLE_STEP_CONFIG
    ];
    expect(stamped).toEqual(config);
  });

  it('a bare @Step() or @Step({ name/input/output only }) stamps no policy at all', () => {
    class Bare {
      @Step()
      noop(_input: unknown) {
        return null;
      }
    }
    class NameOnly {
      @Step({ name: 'custom' })
      noop(_input: unknown) {
        return null;
      }
    }

    expect(stepConfigOf(Bare.prototype.noop)).toBeUndefined();
    expect(stepConfigOf(NameOnly.prototype.noop)).toBeUndefined();
  });
});

describe('DURABLE_STEP_METADATA vs DURABLE_STEP_NAME', () => {
  it('both carry the same resolved name — the registrar reads the former, ctx.step(ref) reads the latter', () => {
    class Svc {
      @Step()
      handle(_input: unknown) {
        return null;
      }
    }

    const meta = Reflect.getMetadata(DURABLE_STEP_METADATA, Svc.prototype.handle) as {
      name: string;
    };
    const stamped = (Svc.prototype.handle as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME];
    expect(meta.name).toBe('Svc.handle');
    expect(stamped).toBe(meta.name);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: `ctx.step(this.svc.method, input)` (method-reference form) routes to a bare
// `@Step()`-derived name, served in-process by the event-emitter transport via the registrar.
// ---------------------------------------------------------------------------

@Injectable()
class PaymentsService {
  @Step()
  async chargeCard(input: { amount: number }) {
    return { chargeId: `ch_${input.amount}` };
  }
}

@Workflow({ name: 'checkout-by-ref', version: '1' })
class CheckoutByRefWorkflow {
  constructor(private readonly payments: PaymentsService) {}

  async run(ctx: WorkflowCtx, order: { amount: number }) {
    const charge = await ctx.step(this.payments.chargeCard, { amount: order.amount });
    return charge.chargeId;
  }
}

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 50; i += 1) {
    const run = await store.getRun(runId);
    if (run?.status === 'completed' || run?.status === 'failed') return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`run ${runId} did not settle`);
}

describe('ctx.step(this.svc.method, input) — reference form end-to-end', () => {
  it('dispatches to the bare-@Step-derived name and completes', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        DurableModule.forRootAsync({
          inject: [EventEmitter2],
          useFactory: (emitter: EventEmitter2) => ({
            store,
            transport: new EventEmitterTransport(emitter),
          }),
        }),
      ],
      providers: [PaymentsService, CheckoutByRefWorkflow],
    }).compile();
    await moduleRef.init();

    await moduleRef.get(WorkflowService).start('checkout-by-ref', { amount: 42 }, 'run1');
    const result = await settle(store, 'run1');

    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('ch_42');
    await moduleRef.close();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: `@Step({ input, output })` — runtime zod validation at the serve boundary.
// ---------------------------------------------------------------------------

@Injectable()
class ValidatedPaymentsService {
  @Step({
    input: z.object({ amount: z.number().positive() }),
    output: z.object({ chargeId: z.string() }),
  })
  async chargeCard(input: { amount: number }) {
    return { chargeId: `ch_${input.amount}` };
  }
}

@Workflow({ name: 'checkout-validated', version: '1' })
class CheckoutValidatedWorkflow {
  constructor(private readonly payments: ValidatedPaymentsService) {}

  async run(ctx: WorkflowCtx, order: { amount: number }) {
    const charge = await ctx.step(this.payments.chargeCard, { amount: order.amount });
    return charge.chargeId;
  }
}

describe('@Step({ input, output }) — runtime validation at serve time', () => {
  it('rejects input that fails the schema — the step (and run) fails', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        DurableModule.forRootAsync({
          inject: [EventEmitter2],
          useFactory: (emitter: EventEmitter2) => ({
            store,
            transport: new EventEmitterTransport(emitter),
          }),
        }),
      ],
      providers: [ValidatedPaymentsService, CheckoutValidatedWorkflow],
    }).compile();
    await moduleRef.init();

    await moduleRef.get(WorkflowService).start('checkout-validated', { amount: -5 }, 'bad1');
    const result = await settle(store, 'bad1');

    expect(result?.status).toBe('failed');
    await moduleRef.close();
  });

  it('passes valid input through and returns the (schema-checked) output', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        DurableModule.forRootAsync({
          inject: [EventEmitter2],
          useFactory: (emitter: EventEmitter2) => ({
            store,
            transport: new EventEmitterTransport(emitter),
          }),
        }),
      ],
      providers: [ValidatedPaymentsService, CheckoutValidatedWorkflow],
    }).compile();
    await moduleRef.init();

    await moduleRef.get(WorkflowService).start('checkout-validated', { amount: 42 }, 'good1');
    const result = await settle(store, 'good1');

    expect(result?.status).toBe('completed');
    expect(result?.output).toBe('ch_42');
    await moduleRef.close();
  });
});
