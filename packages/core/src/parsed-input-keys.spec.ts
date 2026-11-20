import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { FatalError } from './errors';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

/**
 * `register(..., { parseInput })`: the `singleton` and `concurrency` keys read the parsed input (the
 * value the body gets, here a `{ company }` built from a raw `{ c }`), never the input as sent, on
 * every path that evaluates them. The run still stores the input as sent.
 */

interface Raw {
  c: string;
}
interface Parsed {
  company: string;
}

const parseInput = async (input: unknown): Promise<Parsed> => {
  const raw = input as Raw;
  if (typeof raw?.c !== 'string') throw new Error('invalid');
  return { company: raw.c.toUpperCase() };
};

function setup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  const seen: unknown[] = [];
  const key = (input: unknown) => {
    seen.push(input);
    return `company:${(input as Parsed).company}`;
  };
  return { store, engine, seen, key };
}

describe('the keys read the parsed input when the workflow registers parseInput', () => {
  it('at start: the singleton and concurrency keys, and the stamped tags', async () => {
    const { store, engine, seen, key } = setup();
    engine.register('job', '1', async () => 'done', {
      parseInput,
      singleton: { key },
      concurrency: { key, limit: 5 },
    });
    await startRun(engine, 'job', { c: 'acme' }, 'r1');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const input of seen) expect(input).toEqual({ company: 'ACME' });
    const run = await store.getRun('r1');
    expect(run?.input).toEqual({ c: 'acme' });
    expect(run?.tags).toEqual(
      expect.arrayContaining(['singleton:company:ACME', 'concurrency:company:ACME']),
    );
    expect(run?.status).toBe('completed');
  });

  it('a start whose input does not parse is rejected before any key runs', async () => {
    const { store, engine, seen, key } = setup();
    engine.register('job', '1', async () => 'done', {
      parseInput,
      validateInput: async (input) => void (await parseInput(input)),
      singleton: { key },
    });
    await expect(engine.start('job', { nope: 1 }, 'bad')).rejects.toThrow('invalid');
    expect(seen).toEqual([]);
    expect(await store.getRun('bad')).toBeNull();
  });

  it("at each turn's admission: a resumed run is admitted under the key of its parsed input", async () => {
    const { store, engine, seen, key } = setup();
    engine.register('job', '1', async (ctx) => ctx.waitForSignal(`go:${ctx.runId}`), {
      parseInput,
      singleton: { key },
    });
    await engine.start('job', { c: 'acme' }, 'holder');
    await engine.start('job', { c: 'acme' }, 'waiter');
    await engine.drain();
    expect((await store.getRun('waiter'))?.status).toBe('suspended');
    await engine.signal('go:holder', null);
    await engine.drain();
    await engine.signal('go:waiter', null);
    await engine.drain();
    expect((await store.getRun('holder'))?.status).toBe('completed');
    for (const input of seen) expect(input).toEqual({ company: 'ACME' });
  });

  it('does not admit a run that carries no key tag (a singleton added later): it never runs', async () => {
    // Pre-existing: the store admits only a run that carries the tag it is claimed under, and a run
    // created before the workflow became a singleton carries none. The key is still computed from
    // the parsed input, never the raw one.
    const { store, engine, seen, key } = setup();
    let ran = false;
    engine.register(
      'job',
      '1',
      async () => {
        ran = true;
        return 'done';
      },
      { parseInput, singleton: { key } },
    );
    const now = new Date();
    await store.createRun({
      id: 'legacy',
      workflow: 'job',
      workflowVersion: '1',
      status: 'pending',
      input: { c: 'acme' },
      createdAt: now,
      updatedAt: now,
    });
    await engine.runOne('legacy');
    await engine.drain();
    expect(seen).toEqual([{ company: 'ACME' }]);
    expect(ran).toBe(false);
    const run = await store.getRun('legacy');
    expect(run?.status).not.toBe('completed');
    expect(run?.tags ?? []).not.toContain('durable:singleton:admitted');
  });

  it('runs a turn whose stored input no longer parses without a slot, so the body can fail it', async () => {
    const { store, engine, seen } = setup();
    engine.register(
      'job',
      '1',
      async (_ctx, input) => {
        // What the nestjs body wrapper does first: parse, failing the run on invalid input.
        await parseInput(input);
        return 'done';
      },
      {
        parseInput,
        singleton: {
          key: (input) => {
            seen.push(input);
            return 'k';
          },
        },
      },
    );
    const now = new Date();
    await store.createRun({
      id: 'stale',
      workflow: 'job',
      workflowVersion: '1',
      status: 'pending',
      input: { other: true },
      tags: ['singleton:k'],
      createdAt: now,
      updatedAt: now,
    });
    await engine.runOne('stale');
    await engine.waitForRun('stale');
    // The key is never called with the raw input, and the run settles instead of waiting forever.
    expect(seen).toEqual([]);
    expect((await store.getRun('stale'))?.status).toBe('failed');
  });

  it('a requeued run is admitted again under the key of its parsed input', async () => {
    const { store, engine, seen, key } = setup();
    let fail = true;
    engine.register(
      'job',
      '1',
      async (ctx) =>
        ctx.localStep('work', async () => {
          if (fail) throw new FatalError('boom');
          return 'done';
        }),
      { parseInput, singleton: { key } },
    );
    await startRun(engine, 'job', { c: 'acme' }, 'r1');
    expect((await store.getRun('r1'))?.status).toBe('failed');
    fail = false;
    await engine.requeue('r1');
    await engine.waitForRun('r1');
    expect((await store.getRun('r1'))?.status).toBe('completed');
    expect(seen.length).toBeGreaterThan(0);
    for (const input of seen) expect(input).toEqual({ company: 'ACME' });
  });

  it('without parseInput the keys read the input as sent, as before', async () => {
    const { store, engine, seen } = setup();
    const raw = (input: unknown) => {
      seen.push(input);
      return `c:${(input as Raw).c}`;
    };
    engine.register('job', '1', async () => 'done', {
      singleton: { key: raw },
      concurrency: { key: raw, limit: 5 },
    });
    await startRun(engine, 'job', { c: 'acme' }, 'r1');
    expect(seen.length).toBeGreaterThan(0);
    for (const input of seen) expect(input).toEqual({ c: 'acme' });
    expect((await store.getRun('r1'))?.tags).toEqual(
      expect.arrayContaining(['singleton:c:acme', 'concurrency:c:acme']),
    );
  });

  it('admits a run queued before the upgrade under the raw-input key it was stamped with', async () => {
    const { store, engine } = setup();
    let ran = false;
    engine.register(
      'job',
      '1',
      async () => {
        ran = true;
        return 'done';
      },
      {
        parseInput,
        // Written for either shape, as a key that worked before the upgrade still does.
        singleton: {
          key: (input) =>
            `company:${(input as Partial<Parsed>).company ?? (input as Partial<Raw>).c}`,
        },
      },
    );
    const now = new Date();
    await store.createRun({
      id: 'queued-before',
      workflow: 'job',
      workflowVersion: '1',
      status: 'pending',
      input: { c: 'acme' },
      tags: ['singleton:company:acme'],
      createdAt: now,
      updatedAt: now,
    });
    await engine.runOne('queued-before');
    await engine.waitForRun('queued-before');
    expect(ran).toBe(true);
    expect((await store.getRun('queued-before'))?.status).toBe('completed');
  });

  it('parses the input once at start and hands the parsed value to validateInput', async () => {
    const { engine } = setup();
    let parses = 0;
    const validated: unknown[] = [];
    engine.register('job', '1', async () => 'done', {
      parseInput: async (input) => {
        parses += 1;
        return parseInput(input);
      },
      validateInput: (input) => void validated.push(input),
      singleton: { key: () => 'k' },
      concurrency: { key: () => 'q', limit: 5 },
    });
    await engine.start('job', { c: 'acme' }, 'r1');
    expect(parses).toBe(1);
    expect(validated).toEqual([{ company: 'ACME' }]);
    await engine.drain();
  });

  it('a tenant start whose input does not parse is recorded as rejected, not thrown', async () => {
    const { store, engine, seen, key } = setup();
    engine.register('job', '1', async () => 'done', { parseInput, singleton: { key } });
    const result = await engine.startForTenant(
      { tenant: 'acme', workflow: 'job', input: { nope: 1 }, runId: 'bad' },
      'acme',
      {},
    );
    expect(result.status).toBe('failed');
    expect((await store.getRun('bad'))?.status).toBe('failed');
    expect(seen).toEqual([]);
  });
});

describe('caller tags never carry a singleton key', () => {
  it('drops a caller `singleton:` tag, so a run cannot queue or be admitted under a key it lacks', async () => {
    const { store, engine } = setup();
    const entered: string[] = [];
    engine.register(
      'job',
      '1',
      async (ctx) => {
        await ctx.localStep('enter', async () => void entered.push(ctx.runId));
        await ctx.waitForSignal(`go:${ctx.runId}`);
      },
      { parseInput, singleton: { key: (input) => `company:${(input as Parsed).company}` } },
    );
    await engine.start('job', { c: 'acme' }, 'a', { tags: ['singleton:other', 'mine'] });
    await engine.start('job', { c: 'acme' }, 'b', { tags: ['singleton:elsewhere'] });
    await engine.drain();
    // One logical key, one slot: the second run waits behind the first.
    expect(entered).toEqual(['a']);
    expect((await store.getRun('b'))?.status).toBe('suspended');
    const a = await store.getRun('a');
    expect(a?.tags).toEqual(expect.arrayContaining(['mine', 'singleton:company:ACME']));
    expect(a?.tags).not.toContain('singleton:other');
    expect((await store.getRun('b'))?.tags).not.toContain('singleton:elsewhere');
  });

  it('a static @Workflow tag with the prefix is dropped too', async () => {
    const { store, engine } = setup();
    engine.register('job', '1', async () => 'done', {
      tags: ['singleton:static', 'billing'],
      singleton: { key: () => 'k' },
    });
    await engine.start('job', {}, 'r1');
    await engine.drain();
    const tags = (await store.getRun('r1'))?.tags ?? [];
    expect(tags.filter((t) => t.startsWith('singleton:'))).toEqual(['singleton:k']);
    expect(tags).toContain('billing');
  });

  it('retryWithInput re-derives the key from the new input instead of keeping the old tag', async () => {
    const { store, engine } = setup();
    engine.register('job', '1', async () => 'done', {
      parseInput,
      singleton: { key: (input) => `company:${(input as Parsed).company}` },
    });
    await startRun(engine, 'job', { c: 'acme' }, 'r1');
    const retried = await engine.retryWithInput('r1', { c: 'globex' }, 'r2');
    expect(retried).toEqual({ runId: 'r2' });
    await engine.drain();
    const tags = (await store.getRun('r2'))?.tags ?? [];
    expect(tags.filter((t) => t.startsWith('singleton:'))).toEqual(['singleton:company:GLOBEX']);
  });
});
