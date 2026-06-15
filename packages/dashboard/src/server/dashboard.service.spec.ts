import {
  InMemoryStateStore,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { DashboardService } from './dashboard.service';

function setup() {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  const service = new DashboardService(store, engine);
  return { store, engine, service };
}

describe('DashboardService', () => {
  it('bulk-retries every failed run matching a tag', async () => {
    const { engine, store, service } = setup();
    let attempts = 0;
    engine.register('flaky', '1', async (ctx: WorkflowCtx) => {
      await ctx.step('s', async () => {
        attempts += 1;
        if (attempts <= 2) throw new Error('boom'); // first two runs fail
        return 'ok';
      });
      return 'done';
    });
    await engine.start('flaky', {}, 'f1', { tags: ['etl'] });
    await engine.start('flaky', {}, 'f2', { tags: ['other'] });
    expect((await store.getRun('f1'))?.status).toBe('failed');
    expect((await store.getRun('f2'))?.status).toBe('failed');

    // Retry only the `failed` runs tagged `etl` → f1 resumes (attempt 3 succeeds), f2 untouched.
    const res = await service.bulk('retry', { status: 'failed', tag: 'etl' });
    expect(res).toEqual({ matched: 1, applied: 1 });
    expect((await store.getRun('f1'))?.status).toBe('completed');
    expect((await store.getRun('f2'))?.status).toBe('failed');
  });

  it('lists runs and returns a run with its step timeline', async () => {
    const { engine, service } = setup();
    engine.register('checkout', '1', async (ctx: WorkflowCtx) => {
      await ctx.step('reserve', async () => 1);
      await ctx.step('charge', async () => 2);
      return 'done';
    });
    await engine.start('checkout', { orderId: 'o1' }, 'r1');

    const runs = await service.listRuns({});
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('completed');

    const detail = await service.getRunDetail('r1');
    expect(detail?.run.workflow).toBe('checkout');
    expect(detail?.timeline.map((s) => s.name)).toEqual(['reserve', 'charge']);
  });

  it('returns null for an unknown run', async () => {
    const { service } = setup();
    expect(await service.getRunDetail('nope')).toBeNull();
  });

  it('reads a published event value and delivers a validated update', async () => {
    const { engine, service } = setup();
    engine.register('job', '1', async (ctx: WorkflowCtx) => {
      await ctx.setEvent('progress', 25);
      const go = await ctx.onUpdate<{ ok: boolean }>('go');
      return go.ok ? 'finished' : 'aborted';
    });
    engine.registerUpdateValidator('job', 'go', (arg: { ok?: boolean }) => {
      if (arg?.ok === undefined) throw new Error('ok is required');
    });
    await engine.start('job', {}, 'r1');

    expect(await service.getEvent('r1', 'progress')).toBe(25);

    const rejected = await service.update('r1', 'go', {});
    expect(rejected.accepted).toBe(false);

    const accepted = await service.update('r1', 'go', { ok: true });
    expect(accepted.accepted).toBe(true);
    expect((await service.getRunDetail('r1'))?.run.output).toBe('finished');
  });

  it('delivers a webhook callback to the waiting run, and reports no-op for an unknown token', async () => {
    const { engine, service } = setup();
    engine.register('approval', '1', async (ctx: WorkflowCtx) => {
      const wh = ctx.webhook<{ approved: boolean }>();
      const payload = await wh.wait();
      return payload.approved;
    });
    await engine.start('approval', {}, 'r1');
    expect((await service.getRunDetail('r1'))?.run.status).toBe('suspended');

    const delivered = await service.deliverWebhook('wh:r1:0', { approved: true });
    expect(delivered?.status).toBe('completed');
    expect((await service.getRunDetail('r1'))?.run.output).toBe(true);

    expect(await service.deliverWebhook('wh:unknown:0', {})).toBeNull();
  });

  it('retries a failed run and can cancel a suspended one', async () => {
    const { engine, service } = setup();
    let fail = true;
    engine.register('wf', '1', async (ctx: WorkflowCtx) =>
      ctx.step('s', async () => {
        if (fail) {
          fail = false;
          throw new Error('boom');
        }
        return 'ok';
      }),
    );
    await engine.start('wf', {}, 'r1');
    expect((await service.getRunDetail('r1'))?.run.status).toBe('failed');

    const retried = await service.retry('r1');
    expect(retried.status).toBe('completed');

    engine.register('waiter', '1', async (ctx: WorkflowCtx) => ctx.waitForSignal('go'));
    await engine.start('waiter', {}, 'r2');
    const cancelled = await service.cancel('r2');
    expect(cancelled?.status).toBe('cancelled');
  });
});
