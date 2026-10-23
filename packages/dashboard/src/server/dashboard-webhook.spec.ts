import { InMemoryStateStore, type RunGateway, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';

const gateway = {} as RunGateway;

function setup() {
  let now = 1_000;
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store, clock: () => now });
  engine.register('wf', '1', async (ctx) => {
    const wh = ctx.webhook<{ ok: boolean }>();
    await ctx.sleep('10s'); // the url is out, the run is parked BEFORE wait()
    return wh.wait();
  });
  const svc = new DashboardService(gateway, store, engine);
  const advance = (ms: number): number => {
    now += ms;
    return now;
  };
  return { store, engine, svc, advance };
}

describe('DashboardService.deliverWebhook', () => {
  it('buffers a callback that beats wait() on a live run, and the wait consumes it', async () => {
    const { store, engine, svc, advance } = setup();
    await engine.start('wf', {}, 'r1');
    await engine.waitForRun('r1');

    const res = await svc.deliverWebhook('wh:r1:0', { ok: true });
    expect(res).toEqual({ runId: 'r1', status: 'suspended' }); // accepted, not a 404

    await engine.resumeDueTimers(advance(20_000));
    const run = await store.getRun('r1');
    expect(run?.status).toBe('completed');
    expect(run?.output).toEqual({ ok: true });
  });

  it('answers null (404) for an unknown run, a non-webhook token, or a terminal run — buffering nothing', async () => {
    const { store, engine, svc, advance } = setup();
    expect(await svc.deliverWebhook('wh:nope:0', { ok: true })).toBeNull();
    expect(await store.takeBufferedSignal('wh:nope:0')).toBeNull();

    expect(await svc.deliverWebhook('garbage', { ok: true })).toBeNull();
    expect(await store.takeBufferedSignal('garbage')).toBeNull();

    await engine.start('wf', {}, 'r2');
    await engine.waitForRun('r2');
    await svc.deliverWebhook('wh:r2:0', { ok: true });
    await engine.resumeDueTimers(advance(20_000));
    expect((await store.getRun('r2'))?.status).toBe('completed');

    // a duplicate callback after the run finished: no junk row left behind
    expect(await svc.deliverWebhook('wh:r2:0', { ok: false })).toBeNull();
    expect(await store.takeBufferedSignal('wh:r2:0')).toBeNull();
  });
});

describe('DashboardService.deliverWebhook — concurrent duplicate', () => {
  it('a duplicate that lost the race to a resolved wait takes its buffered row back and 404s', async () => {
    const { store, engine, svc, advance } = setup();
    await engine.start('wf', {}, 'r3');
    await engine.waitForRun('r3');
    await svc.deliverWebhook('wh:r3:0', { ok: true });
    await engine.resumeDueTimers(advance(20_000));
    expect((await store.getRun('r3'))?.status).toBe('completed');

    // Replay the race: the duplicate's pre-check ran while the run was still live and unresolved.
    const realGetRun = store.getRun.bind(store);
    const realGetCheckpoint = store.getCheckpoint.bind(store);
    let firstRun = true;
    let firstCp = true;
    store.getRun = async (id) => {
      const r = await realGetRun(id);
      if (firstRun && r) {
        firstRun = false;
        return { ...r, status: 'suspended' };
      }
      return r;
    };
    store.getCheckpoint = async (id, seq) => {
      if (firstCp) {
        firstCp = false;
        return null;
      }
      return realGetCheckpoint(id, seq);
    };
    expect(await svc.deliverWebhook('wh:r3:0', { ok: 'dup' })).toBeNull();
    expect(await store.takeBufferedSignal('wh:r3:0')).toBeNull(); // no junk row left behind
  });
});
