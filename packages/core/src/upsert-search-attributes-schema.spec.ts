import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowEngine } from './engine';
import type { SearchAttributes } from './interfaces';
import type { StandardSchemaV1 } from './standard-schema';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

const tierAttrs = z.object({
  tier: z.enum(['free', 'pro']),
  amount: z.number(),
});

// Two independent cross-field rules over the same (all-optional) shape — lets a single schema
// exercise both directions of "validate the merge, not the patch":
//  - an archived run can't be tier "pro"
//  - a rush order needs an amount set
const mergeRulesAttrs = z
  .object({
    tier: z.enum(['free', 'pro']).optional(),
    archived: z.boolean().optional(),
    amount: z.number().optional(),
    rushOrder: z.boolean().optional(),
  })
  .refine((v) => !(v.archived && v.tier === 'pro'), {
    message: 'an archived run cannot be tier "pro"',
    path: ['archived'],
  })
  .refine((v) => !v.rushOrder || v.amount !== undefined, {
    message: 'a rush order needs an amount',
    path: ['amount'],
  });

describe('ctx.upsertSearchAttributes — @Workflow({ searchAttributes }) schema validation', () => {
  it('passes valid attrs through and persists them, same as with no schema declared', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        await ctx.upsertSearchAttributes({ tier: 'pro', amount: 10 });
        return 'done';
      },
      { searchAttributesSchema: tierAttrs },
    );

    const result = await startRun(engine, 'checkout', {}, 'r1');

    expect(result.status).toBe('completed');
    expect((await store.getRun('r1'))?.searchAttributes).toEqual({ tier: 'pro', amount: 10 });
  });

  it('rejects a wrong-typed value, failing the run with the workflow name and offending key named', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        // `amount` typed as a string here — invalid per the schema (a number), though a plain
        // string is a perfectly ordinary SearchAttributes value at the (unparameterized) ctx type.
        await ctx.upsertSearchAttributes({ tier: 'pro', amount: 'lots' });
        return 'done';
      },
      { searchAttributesSchema: tierAttrs },
    );

    const result = await startRun(engine, 'checkout', {}, 'r2');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('checkout');
    expect(result.error?.message).toContain('amount');
    expect((await store.getRun('r2'))?.searchAttributes).toBeUndefined();
  });

  it('rejects an unknown key on a strict schema', async () => {
    const store = new InMemoryStateStore();
    const strictAttrs = z.object({ tier: z.enum(['free', 'pro']) }).strict();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        await ctx.upsertSearchAttributes({ tier: 'pro', extra: 'not declared' });
        return 'done';
      },
      { searchAttributesSchema: strictAttrs },
    );

    const result = await startRun(engine, 'checkout', {}, 'r3');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('checkout');
    expect(result.error?.message).toContain('extra');
  });

  it('validates the MERGED result — a patch valid alone can be invalid once merged with existing attributes', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        await ctx.upsertSearchAttributes({ tier: 'pro' }); // valid alone, and valid as a merge (nothing archived yet)
        // `{ archived: true }` on its own doesn't violate the rule (tier is undefined in isolation),
        // but merged with the already-persisted `tier: 'pro'` it does.
        await ctx.upsertSearchAttributes({ archived: true });
        return 'done';
      },
      { searchAttributesSchema: mergeRulesAttrs },
    );

    const result = await startRun(engine, 'checkout', {}, 'r4');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('checkout');
    expect(result.error?.message).toContain('archived');
    // The first (valid) upsert landed; the second was rejected before it could persist.
    expect((await store.getRun('r4'))?.searchAttributes).toEqual({ tier: 'pro' });
  });

  it('validates the MERGED result — a patch invalid alone can be valid once merged with existing attributes', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        await ctx.upsertSearchAttributes({ amount: 150 });
        // `{ rushOrder: true }` on its own would need `amount` set — but it already is, from the
        // previous call, so the MERGED result satisfies the rule.
        await ctx.upsertSearchAttributes({ rushOrder: true });
        return 'done';
      },
      { searchAttributesSchema: mergeRulesAttrs },
    );

    const result = await startRun(engine, 'checkout', {}, 'r5');

    expect(result.status).toBe('completed');
    expect((await store.getRun('r5'))?.searchAttributes).toEqual({ amount: 150, rushOrder: true });
  });

  it('does not re-validate on replay — the schema runs once per call, not once per turn', async () => {
    const store = new InMemoryStateStore();
    const schema = z.object({ tier: z.enum(['free', 'pro']), amount: z.number() });
    let validateCalls = 0;
    const originalValidate = schema['~standard'].validate.bind(schema['~standard']);
    schema['~standard'].validate = (value) => {
      validateCalls += 1;
      return originalValidate(value);
    };

    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        await ctx.upsertSearchAttributes({ tier: 'pro', amount: 10 });
        await ctx.waitForSignal('go'); // suspends after the upsert, forcing a second turn (replay)
        return 'done';
      },
      { searchAttributesSchema: schema },
    );

    await startRun(engine, 'checkout', {}, 'r6');
    expect(validateCalls).toBe(1); // applied on the first turn

    const resumed = await engine.signal('go', undefined); // resume replays the body — the upsert is a no-op now
    expect(resumed?.status).toBe('completed');
    expect(validateCalls).toBe(1); // NOT re-run on replay
  });

  it('throws a clear error when the schema validator is async — write-time validation must be synchronous', async () => {
    const store = new InMemoryStateStore();
    const asyncSchema: StandardSchemaV1<unknown, SearchAttributes> = {
      '~standard': {
        version: 1,
        vendor: 'test-async',
        validate: async (value) => ({ value: value as SearchAttributes }),
      },
    };
    const engine = new WorkflowEngine({ store });
    engine.register(
      'checkout',
      '1',
      async (ctx) => {
        await ctx.upsertSearchAttributes({ tier: 'pro' });
        return 'done';
      },
      { searchAttributesSchema: asyncSchema },
    );

    const result = await startRun(engine, 'checkout', {}, 'r7');

    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/synchronous/);
  });
});
