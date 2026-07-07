import { describe, expect, it } from 'vitest';
import { currentWorkflowCtx } from './ambient-ctx';
import { DurableWorkflow, bindWorkflowClass } from './durable-workflow';
import { WorkflowEngine } from './engine';
import { FatalError } from './errors';
import type { WorkflowCtx } from './interfaces';
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

/** Bind a class to an engine the way the NestJS registrar does at boot. */
function bindTo(engine: WorkflowEngine, cls: abstract new (...args: never[]) => unknown): void {
  bindWorkflowClass(cls, {
    start: (name, input, runId, opts) => engine.start(name, input, runId, opts),
    waitForRun: (runId, opts) => engine.waitForRun(runId, opts),
  });
}

describe('DurableWorkflow class-first statics', () => {
  it('start OUTSIDE a workflow is exactly engine.start: enqueue, immediate RunResult', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class Greet extends DurableWorkflow {
      async run(_ctx: WorkflowCtx, input: { name: string }) {
        return `hi ${input.name}`;
      }
    }
    named(Greet, 'greet');
    engine.register('greet', '1', (ctx, input) => new Greet().run(ctx, input as { name: string }));
    bindTo(engine, Greet);

    const res = await Greet.start({ name: 'davi' });
    expect(res.status).toBe('pending');
    const settled = await engine.waitForRun(res.runId);
    expect(settled.output).toBe('hi davi');
  });

  it('execute OUTSIDE a workflow starts and awaits the typed output — through a real suspension', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class ChildWf extends DurableWorkflow {
      async run(): Promise<{ doubled: number }> {
        return { doubled: 42 };
      }
    }
    named(ChildWf, 'dw-child');
    engine.register('dw-child', '1', () => new ChildWf().run());
    // The parent suspends on ctx.child — `until: 'terminal'` must wait PAST that suspension.
    class ParentWf extends DurableWorkflow {
      async run(ctx: WorkflowCtx) {
        const r = await ctx.child(ChildWf, {} as never);
        return r.doubled;
      }
    }
    named(ParentWf, 'dw-parent');
    engine.register('dw-parent', '1', (ctx) => new ParentWf().run(ctx));
    bindTo(engine, ParentWf);

    const out = await ParentWf.execute({} as never, { timeoutMs: 2000 });
    expect(out).toBe(42);
  });

  it('execute OUTSIDE throws FatalError when the run fails', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class Boom extends DurableWorkflow {
      async run(): Promise<void> {
        throw new FatalError('boom', 'boom_code');
      }
    }
    named(Boom, 'dw-boom');
    engine.register('dw-boom', '1', () => new Boom().run());
    bindTo(engine, Boom);

    await expect(Boom.execute(undefined as never, { timeoutMs: 2000 })).rejects.toThrow(/boom/);
  });

  it('INSIDE a workflow, execute = ctx.child (awaited) and start = ctx.startChild (fire-and-forget)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class InnerWf extends DurableWorkflow {
      async run(_ctx: WorkflowCtx, input: { n: number }) {
        return { doubled: input.n * 2 };
      }
    }
    named(InnerWf, 'dw-inner');
    engine.register('dw-inner', '1', (ctx, input) =>
      new InnerWf().run(ctx, input as { n: number }),
    );
    class SideWf extends DurableWorkflow {
      async run(): Promise<string> {
        return 'side done';
      }
    }
    named(SideWf, 'dw-side');
    engine.register('dw-side', '1', () => new SideWf().run());

    // The outer body uses ONLY the statics — no ctx threading. The ambient context makes them
    // resolve to ctx.child / ctx.startChild, so both are checkpointed and replay-safe.
    engine.register('dw-outer', '1', async () => {
      const inner = await InnerWf.execute({ n: 21 });
      const side = await SideWf.start(undefined as never);
      return { doubled: inner.doubled, sideRunId: side.runId, sideStatus: side.status };
    });

    await engine.start('dw-outer', {}, 'outer-1');
    const settled = await engine.waitForRun('outer-1', { timeoutMs: 2000, until: 'terminal' });
    expect(settled.status).toBe('completed');
    const output = settled.output as { doubled: number; sideRunId: string; sideStatus: string };
    expect(output.doubled).toBe(42);
    expect(output.sideStatus).toBe('pending');
    // The fire-and-forget child is a real run of its own and completes independently.
    await poll(async () => (await store.getRun(output.sideRunId))?.status === 'completed');
    expect((await store.getRun(output.sideRunId))?.output).toBe('side done');
  });

  it('the body sees the ambient ctx — currentWorkflowCtx() IS the ctx the body received', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('dw-ambient', '1', async (ctx) => currentWorkflowCtx() === ctx);
    await engine.start('dw-ambient', {}, 'amb-1');
    const settled = await engine.waitForRun('amb-1', { timeoutMs: 2000, until: 'terminal' });
    expect(settled.output).toBe(true);
  });

  it('an unbound class throws a clear error instead of failing silently', async () => {
    class Nowhere extends DurableWorkflow {
      async run(): Promise<void> {}
    }
    named(Nowhere, 'dw-nowhere');
    await expect(Nowhere.start(undefined as never)).rejects.toThrow(
      /not bound to a durable engine/,
    );
  });

  it('a store-less start facade (no waitForRun) supports start but rejects execute clearly', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    class TenantWf extends DurableWorkflow {
      async run(): Promise<string> {
        return 'ok';
      }
    }
    named(TenantWf, 'dw-tenant');
    engine.register('dw-tenant', '1', () => new TenantWf().run());
    // Bind WITHOUT waitForRun — the shape of a tenant's DurableStartClient.
    bindWorkflowClass(TenantWf, {
      start: (name, input, runId, opts) => engine.start(name, input, runId, opts),
    });

    const res = await TenantWf.start(undefined as never);
    expect(res.runId).toBeTruthy();
    await expect(TenantWf.execute(undefined as never)).rejects.toThrow(/store-less start facade/);
  });
});
