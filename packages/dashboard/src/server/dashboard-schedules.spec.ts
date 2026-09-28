import { InMemoryStateStore, type RunGateway, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';

const gateway = {} as RunGateway;

describe('DashboardService schedules', () => {
  it('lists, pauses, resumes and triggers persisted schedules on the control plane', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async () => 'ok');
    await engine.schedules.create({ id: 'nightly', workflow: 'job', cron: '0 3 * * *' });
    const svc = new DashboardService(gateway, store, engine);

    expect((await svc.listSchedules({})).map((s) => s.id)).toEqual(['nightly']);
    expect((await svc.pauseSchedule('nightly')).paused).toBe(true);
    expect((await svc.resumeSchedule('nightly')).paused).toBe(false);
    const { runId } = await svc.triggerSchedule('nightly');
    expect(await store.getRun(runId)).not.toBeNull();
  });

  it('lists nothing on a tenant (no store)', async () => {
    const svc = new DashboardService(gateway, undefined, undefined);
    expect(await svc.listSchedules({})).toEqual([]);
    expect(() => svc.pauseSchedule('x')).toThrow(/control plane/);
  });
});
