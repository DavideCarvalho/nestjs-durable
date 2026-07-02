import {
  InMemoryStateStore,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { StoreRunGateway } from './store-run-gateway';

/**
 * Real-engine coverage for `StoreRunGateway`'s six read/control method bodies — ported from
 * `dashboard.service.spec.ts` (whose `DashboardService(store, engine)` cases exercise the SAME
 * bodies verbatim) so this coverage survives a later refactor of that spec to a fake gateway.
 * `bulk` isn't on the port (it's a dashboard concern); its underlying semantic — retry re-enqueues a
 * failed run, which a worker then replays to completion — is proven directly via `gateway.retry`.
 */
function setup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  const gateway = new StoreRunGateway(store, engine);
  return { store, engine, gateway };
}

describe('StoreRunGateway', () => {
  it('retry re-enqueues a failed run (the semantic bulk-retry-by-tag relies on), and a worker completes it', async () => {
    const { engine, store, gateway } = setup();
    let attempts = 0;
    // No `: WorkflowCtx` annotation — `register`'s callback is contextually typed as the richer,
    // unexported `InternalWorkflowCtx` (WorkflowCtx + `localStep`), so `ctx.localStep(name, fn, opts)`
    // (the retries/compensate-capable LOCAL step primitive, replacing the old public inline
    // `ctx.step(name, fn, opts)`) is available here without needing to import that type by name.
    engine.register('flaky', '1', async (ctx) => {
      await ctx.localStep('s', async () => {
        attempts += 1;
        if (attempts <= 2) throw new Error('boom'); // first two runs fail
        return 'ok';
      });
      return 'done';
    });
    await engine.start('flaky', {}, 'f1', { tags: ['etl'] });
    await engine.start('flaky', {}, 'f2', { tags: ['other'] });
    await engine.waitForRun('f1');
    await engine.waitForRun('f2');
    expect((await store.getRun('f1'))?.status).toBe('failed');
    expect((await store.getRun('f2'))?.status).toBe('failed');

    // A bulk-retry-by-tag would filter to `failed` runs tagged `etl` (only f1) and call this per
    // match — proving the single-run primitive is enough to prove the batch semantic.
    const retried = await gateway.retry('f1');
    expect(retried?.status).toBe('pending');
    await engine.runPending(); // a worker picks up the re-enqueued run (attempt 3 succeeds)
    await engine.waitForRun('f1');
    expect((await store.getRun('f1'))?.status).toBe('completed');
    expect((await store.getRun('f2'))?.status).toBe('failed'); // untouched
  });

  it('lists runs and returns a run with its step timeline', async () => {
    const { engine, gateway } = setup();
    engine.register('checkout', '1', async (ctx) => {
      await ctx.localStep('reserve', async () => 1);
      await ctx.localStep('charge', async () => 2);
      return 'done';
    });
    await engine.start('checkout', { orderId: 'o1' }, 'r1');
    await engine.waitForRun('r1');

    const runs = await gateway.listRuns({});
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');

    const detail = await gateway.getRunDetail('r1');
    expect(detail?.run.workflow).toBe('checkout');
    expect(detail?.timeline.map((s) => s.name)).toEqual(['reserve', 'charge']);
  });

  it('returns null for an unknown run', async () => {
    const { gateway } = setup();
    expect(await gateway.getRunDetail('nope')).toBeNull();
  });

  it('retries a failed run and can cancel a suspended one', async () => {
    const { engine, gateway } = setup();
    let fail = true;
    engine.register('wf', '1', async (ctx) =>
      ctx.localStep('s', async () => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        return 'ok';
      }),
    );
    await engine.start('wf', {}, 'r1');
    await engine.waitForRun('r1');
    expect((await gateway.getRunDetail('r1'))?.run.status).toBe('failed');

    // retry re-enqueues (non-blocking); a worker then re-runs it to completion.
    const retried = await gateway.retry('r1');
    expect(retried?.status).toBe('pending');
    await engine.runPending();
    expect((await engine.waitForRun('r1')).status).toBe('completed');

    engine.register('waiter', '1', async (ctx: WorkflowCtx) => ctx.waitForSignal('go'));
    await engine.start('waiter', {}, 'r2');
    await engine.waitForRun('r2');
    const cancelled = await gateway.cancel('r2');
    expect(cancelled?.status).toBe('cancelled');
  });

  it('cancel({ compensate: true }) reaches engine.cancel, undoing completed steps before settling cancelled', async () => {
    const { engine, store, gateway } = setup();
    const undone: string[] = [];
    engine.register('saga', '1', async (ctx) => {
      await ctx.localStep('reserve', async () => 'r', {
        compensate: async () => {
          undone.push('reserve');
        },
      });
      await ctx.localStep('pack', async () => 'p', {
        compensate: async () => {
          undone.push('pack');
        },
      });
      await ctx.waitForSignal('ship'); // run suspends here, mid-saga
      return 'done';
    });
    await engine.start('saga', {}, 'r1');
    await engine.waitForRun('r1');
    expect((await store.getRun('r1'))?.status).toBe('suspended');

    // Compensate-cancel returns immediately (non-blocking) and runs the undo in the background.
    await gateway.cancel('r1', { compensate: true });
    for (let i = 0; i < 100 && (await store.getRun('r1'))?.status !== 'cancelled'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(undone).toEqual(['pack', 'reserve']); // reverse order
    expect((await store.getRun('r1'))?.status).toBe('cancelled');
  });

  it('retryWithInput re-runs a failed run with corrected input as a fresh linked run', async () => {
    const { engine, store, gateway } = setup();
    const inputSchema = z.object({ ok: z.boolean() });
    engine.register('w', '1', async (_ctx: WorkflowCtx, input) => {
      const { ok } = inputSchema.parse(input);
      if (!ok) throw new Error('bad input');
      return 'shipped';
    });
    await engine.start('w', { ok: false }, 'r1');
    expect((await engine.waitForRun('r1')).status).toBe('failed');

    const retried = await gateway.retryWithInput('r1', { ok: true });
    expect(retried?.runId).toMatch(/^r1~retry~/);
    if (!retried) throw new Error('retryWithInput should return a linked run');
    const result = await engine.waitForRun(retried.runId);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('shipped');

    // The original is untouched.
    expect((await store.getRun('r1'))?.status).toBe('failed');
  });

  it('subscribe delivers only events for the requested run, and unsubscribe stops delivery', async () => {
    const { engine, gateway } = setup();
    engine.register('echo', '1', async (_ctx: WorkflowCtx, input) => input);

    const seen: string[] = [];
    const unsubscribe = gateway.subscribe('r1', (event) => {
      seen.push(event.type);
    });

    await engine.start('echo', {}, 'other');
    await engine.waitForRun('other');
    expect(seen).toEqual([]); // a different run's events are filtered out

    await engine.start('echo', {}, 'r1');
    await engine.waitForRun('r1');
    expect(seen).toContain('run.completed');

    unsubscribe();
    seen.length = 0;
    await engine.start('echo', {}, 'r1-again');
    await engine.waitForRun('r1-again');
    expect(seen).toEqual([]); // no more deliveries after unsubscribe
  });
});
