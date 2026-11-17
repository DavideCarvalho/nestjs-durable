import {
  InMemoryStateStore,
  type RunGateway,
  type Transport,
  type WorkerDescriptor,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { withConsoleApps } from './app-scope.js';
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

  it('lists the schedules a tenant app announces with their app, and acts on them', async () => {
    const store = new InMemoryStateStore();
    const tenant: WorkerDescriptor = {
      instanceId: 'acme-1',
      runtime: 'node',
      sdk: { name: 'durable-worker', version: '0' },
      protocol: { version: 1, range: [1, 1] },
      capabilities: [],
      workflows: ['digest'],
      steps: [],
      partition: 'acme',
      startedAt: 0,
      schedules: { tenant: 'acme', items: [{ key: 'daily', workflow: 'digest', everyMs: 60_000 }] },
    };
    const transport: Transport = {
      dispatch: async () => {},
      onResult: () => {},
      onHeartbeat: () => {},
      listWorkerGroups: async () => [],
      readAllWorkerDescriptors: async () => [tenant],
    };
    const engine = new WorkflowEngine({ store, transport, namespace: undefined });
    await engine.syncAnnouncedSchedules();
    const svc = new DashboardService(gateway, store, engine);

    const [listed] = await svc.listSchedules({});
    expect(listed).toMatchObject({
      id: 'app:acme:daily',
      namespace: 'acme',
      announcedKey: 'daily',
    });
    expect((await svc.pauseSchedule('app:acme:daily')).paused).toBe(true);
    // The pause survives the next sync of the unchanged announcement.
    await engine.syncAnnouncedSchedules();
    expect((await engine.schedules.get('app:acme:daily'))?.paused).toBe(true);
    expect((await svc.resumeSchedule('app:acme:daily')).paused).toBe(false);
    // "Run now" with no live tenant worker: the run waits for one.
    const run = await svc.triggerSchedule('app:acme:daily');
    expect(run.status).toBe('blocked');
    expect((await store.getRun(run.runId))?.namespace).toBe('acme');
  });

  it('lists nothing on a tenant (no store)', async () => {
    const svc = new DashboardService(gateway, undefined, undefined);
    expect(await svc.listSchedules({})).toEqual([]);
    expect(() => svc.pauseSchedule('x')).toThrow(/control plane/);
  });

  it("confines schedules to a viewer's apps", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('job', '1', async () => 'ok');
    await engine.schedules.create({
      id: 'a',
      workflow: 'job',
      cron: '0 3 * * *',
      namespace: 'acme',
    });
    await engine.schedules.create({
      id: 'b',
      workflow: 'job',
      cron: '0 4 * * *',
      namespace: 'beta',
    });
    await engine.schedules.create({ id: 'own', workflow: 'job', cron: '0 5 * * *' });
    const svc = new DashboardService(gateway, store, engine);

    expect((await svc.listSchedules({})).map((s) => s.id).sort()).toEqual(['a', 'b', 'own']);
    await withConsoleApps(['acme'], async () => {
      expect((await svc.listSchedules({})).map((s) => s.id)).toEqual(['a']);
      expect(await svc.listSchedules({ namespace: 'beta' })).toEqual([]);
      expect((await svc.pauseSchedule('a')).paused).toBe(true);
      await expect(svc.pauseSchedule('b')).rejects.toMatchObject({ name: 'ScheduleNotFoundError' });
      await expect(svc.triggerSchedule('own')).rejects.toMatchObject({
        name: 'ScheduleNotFoundError',
      });
    });
    expect((await engine.schedules.get('b'))?.paused).toBe(false);
  });
});
