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

  it('admits a run that carries no key tag (singleton added later) under its parsed input', async () => {
    const { store, engine, seen, key } = setup();
    engine.register('job', '1', async () => 'done', { parseInput, singleton: { key } });
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
  });

  it('falls back to the stored input when it no longer parses (the body then fails the run)', async () => {
    const { store, engine, seen } = setup();
    engine.register('job', '1', async () => 'done', {
      parseInput,
      singleton: {
        key: (input) => {
          seen.push(input);
          return 'k';
        },
      },
    });
    const now = new Date();
    await store.createRun({
      id: 'stale',
      workflow: 'job',
      workflowVersion: '1',
      status: 'pending',
      input: { other: true },
      createdAt: now,
      updatedAt: now,
    });
    await engine.runOne('stale');
    await engine.drain();
    expect(seen).toEqual([{ other: true }]);
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
});
