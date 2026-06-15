import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { WORKFLOW_NAME_KEY } from './workflow-ref';

async function poll(fn: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

/** Stamp a class with a registered name, the way the `@Workflow` decorator does. */
function named<T extends abstract new (...args: never[]) => unknown>(cls: T, name: string): T {
  (cls as { [WORKFLOW_NAME_KEY]?: string })[WORKFLOW_NAME_KEY] = name;
  return cls;
}

describe('class-ref forms of child / startChild / start', () => {
  it('engine.start(Class) resolves the class to its registered name', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    class Greet {
      async run(_ctx: unknown, input: { name: string }) {
        return `hi ${input.name}`;
      }
    }
    named(Greet, 'greet');
    engine.register('greet', '1', async (_ctx, input) => `hi ${(input as { name: string }).name}`);

    const res = await startRun(engine, Greet, { name: 'davi' }, 'g1');
    expect(res.output).toBe('hi davi');
  });

  it('ctx.child(Class) resolves the class and resumes the parent with its output', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class ChildWf {
      async run(): Promise<{ doubled: number }> {
        return { doubled: 42 };
      }
    }
    named(ChildWf, 'childwf');
    engine.register('childwf', '1', async () => ({ doubled: 42 }));
    engine.register('parent', '1', async (ctx) => {
      const r = await ctx.child(ChildWf, {});
      return r.doubled;
    });

    const first = await startRun(engine, 'parent', {}, 'p1');
    expect(first.status).toBe('suspended');
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toBe(42);
  });

  it('ctx.startChild(Class) is fire-and-forget: returns the child id and keeps running', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class Audit {
      async run(): Promise<string> {
        return 'logged';
      }
    }
    named(Audit, 'audit');
    let childIdSeen: string | undefined;
    engine.register('audit', '1', async () => 'logged');
    engine.register('parent', '1', async (ctx) => {
      childIdSeen = await ctx.startChild(Audit, {}); // does NOT suspend
      return 'parent-done';
    });

    const res = await startRun(engine, 'parent', {}, 'p1');
    expect(res.status).toBe('completed'); // parent finished without waiting on the child
    expect(res.output).toBe('parent-done');
    expect(childIdSeen).toBe('p1.child.0'); // deterministic default child id

    await poll(async () => (await store.getRun('p1.child.0'))?.status === 'completed');
    expect((await store.getRun('p1.child.0'))?.output).toBe('logged');
  });

  it('startChild + child compose for scatter-gather (same id attaches, child runs once)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let runs = 0;
    engine.register('worker', '1', async () => {
      runs += 1;
      return 'work-result';
    });
    engine.register('parent', '1', async (ctx) => {
      const id = await ctx.startChild('worker', {}, 'shared-child'); // dispatch, don't wait
      const out = await ctx.child<string>('worker', {}, id); // later: join by the same id
      return out;
    });

    await startRun(engine, 'parent', {}, 'p1');
    await poll(async () => (await store.getRun('p1'))?.status === 'completed');
    expect((await store.getRun('p1'))?.output).toBe('work-result');
    expect(runs).toBe(1); // started once, not double-dispatched
  });
});
