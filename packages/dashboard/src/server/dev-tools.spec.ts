import { RunGateway } from '@dudousxd/nestjs-durable-core';
import 'reflect-metadata';
import {
  type DynamicModule,
  type ExecutionContext,
  Global,
  Module,
  NotFoundException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeByToken } from './console-authorize.js';
import type { DashboardService } from './dashboard.service.js';
import { DEV_TOOLS_SLOT, type DurableDevTool, durableDevTools } from './dev-tools.js';
import { DurableDashboardModule } from './durable-dashboard.module.js';

const holder = globalThis as Record<symbol, unknown>;

const RUNS = Array.from({ length: 45 }, (_, i) => ({
  id: `r${i}`,
  workflow: 'billing',
  status: i % 2 === 0 ? 'failed' : 'completed',
  input: { card: '4242' },
  output: { ok: true },
  error: i % 2 === 0 ? { name: 'Error', message: `boom ${i}\n    at stack` } : undefined,
  createdAt: 1,
  updatedAt: 2,
}));

const SCHEDULES = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, workflow: 'nightly' }));

class ScheduleNotFoundError extends Error {
  override name = 'ScheduleNotFoundError';
}

function fakeService(capabilities = { controlPlane: true, schedules: true }) {
  const known = new Set(RUNS.map((run) => run.id));
  const result = (id: string, status: string) => (known.has(id) ? { runId: id, status } : null);
  const service = {
    capabilities: vi.fn(() => capabilities),
    topology: vi.fn(() => ({ role: 'control-plane' })),
    listRuns: vi.fn(async (query: { offset?: number; limit?: number }) =>
      RUNS.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? RUNS.length)),
    ),
    runFacets: vi.fn(async () => [
      { status: 'failed', origin: '@acme/a', count: 3 },
      { status: 'failed', origin: null, count: 2 },
      { status: 'pending', origin: '@acme/a', count: 7 },
      { status: 'blocked', origin: null, count: 1 },
    ]),
    runValueFacets: vi.fn(async () => [
      { value: 'billing', count: 9 },
      { value: 'emails', count: 4 },
      { value: 'etl', count: 1 },
    ]),
    workerHealth: vi.fn(async () => [
      { group: 'billing', kind: 'workflow', depth: 4, liveWorkers: [] },
      { group: 'emails', kind: 'workflow', depth: 0, liveWorkers: [{ instanceId: 'w1' }] },
      { group: 'send', kind: 'step', depth: 9, liveWorkers: [] },
    ]),
    getRunDetail: vi.fn(async (id: string) =>
      known.has(id)
        ? {
            run: { id, status: 'failed' },
            steps: [{ seq: 1 }],
            etag: 'W/"1"',
            notModified: undefined,
          }
        : null,
    ),
    getFanMembers: vi.fn(
      async (id: string, _group: string, query: { offset: number; limit: number }) =>
        known.has(id)
          ? {
              items: Array.from(
                { length: Math.max(0, Math.min(query.limit, 30 - query.offset)) },
                (_, i) => ({
                  seq: query.offset + i,
                }),
              ),
              total: 30,
              etag: 'x',
            }
          : null,
    ),
    listSchedules: vi.fn(async (query: { offset?: number; limit?: number }) =>
      SCHEDULES.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 3)),
    ),
    runExists: vi.fn(async (id: string) => known.has(id)),
    getEvent: vi.fn(async (_id: string, key: string) => (key === 'progress' ? 0.5 : undefined)),
    retry: vi.fn(async (id: string) => {
      if (id === 'r3') throw new Error('run r3 is running');
      return result(id, 'pending');
    }),
    cancel: vi.fn(async (id: string) => result(id, 'cancelled')),
    continue: vi.fn(async (id: string) => (id === 'r1' ? { runId: id, status: 'running' } : null)),
    signal: vi.fn(async (token: string) =>
      token === 'tok' ? { runId: 'r1', status: 'running' } : null,
    ),
    triggerSchedule: vi.fn(async (id: string) => {
      if (id !== 's0') throw new ScheduleNotFoundError(`schedule "${id}" not found`);
      return { runId: 'r9', status: 'pending' };
    }),
    pauseSchedule: vi.fn(async (id: string) => ({ id, paused: true })),
    resumeSchedule: vi.fn(async (id: string) => ({ id, paused: false })),
  };
  return service;
}

type Fake = ReturnType<typeof fakeService>;

function toolsOf(service: Fake): Map<string, DurableDevTool> {
  const tools = durableDevTools(service as unknown as DashboardService);
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function tool(service: Fake, name: string): DurableDevTool {
  const found = toolsOf(service).get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe('the durable tools', () => {
  it('are the spec’s reads and actions; only cancel is destructive', () => {
    const tools = durableDevTools(fakeService() as unknown as DashboardService);
    expect(tools.filter((t) => t.kind === 'read').map((t) => t.name)).toEqual([
      'durable_list_runs',
      'durable_get_run',
      'durable_list_fan_members',
      'durable_count_runs_by',
      'durable_get_health',
      'durable_list_workers',
      'durable_list_schedules',
      'durable_get_run_event',
    ]);
    expect(tools.filter((t) => t.kind === 'action').map((t) => t.name)).toEqual([
      'durable_retry_run',
      'durable_cancel_run',
      'durable_continue_run',
      'durable_signal_run',
      'durable_trigger_schedule',
      'durable_pause_schedule',
    ]);
    expect(tools.filter((t) => t.destructive).map((t) => t.name)).toEqual(['durable_cancel_run']);
    for (const t of tools) {
      expect(t.name).toMatch(/^durable_[a-z]+(_[a-z]+)+$/);
      for (const name of t.input.required ?? []) expect(t.input.properties[name]).toBeDefined();
    }
  });

  it('hide the control-plane tools on a tenant (capability, not access)', async () => {
    const tools = durableDevTools(
      fakeService({ controlPlane: false, schedules: false }) as unknown as DashboardService,
    );
    const hidden: string[] = [];
    for (const t of tools) if (t.available && !(await t.available())) hidden.push(t.name);
    expect(hidden.sort()).toEqual([
      'durable_get_run_event',
      'durable_list_schedules',
      'durable_pause_schedule',
      'durable_signal_run',
      'durable_trigger_schedule',
    ]);
  });
});

describe('durable_list_runs', () => {
  it('pages honestly with a cursor, without payloads, with a one-line error summary', async () => {
    const service = fakeService();
    const list = tool(service, 'durable_list_runs');
    const first = (await list.run({})) as { items: Record<string, unknown>[]; next: string | null };
    expect(first.items).toHaveLength(20);
    expect(first.next).toBe('20');
    expect(first.items[0]).toEqual({
      id: 'r0',
      workflow: 'billing',
      status: 'failed',
      error: 'boom 0',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(first.items[1]).not.toHaveProperty('error');
    expect(service.listRuns).toHaveBeenLastCalledWith({ offset: 0, limit: 21 });

    const last = (await list.run({ cursor: '40', limit: 20 })) as {
      items: unknown[];
      next: unknown;
    };
    expect(last.items).toHaveLength(5);
    expect(last.next).toBeNull();

    // Exactly one page left: no phantom next page.
    const exact = (await list.run({ cursor: '25', limit: 20 })) as {
      items: unknown[];
      next: unknown;
    };
    expect(exact.items).toHaveLength(20);
    expect(exact.next).toBeNull();
  });

  it('passes the console’s filters through', async () => {
    const service = fakeService();
    await tool(service, 'durable_list_runs').run({
      status: 'dead',
      workflow: 'billing',
      tag: 'etl',
      namespace: 'eu',
      origin: '@acme/billing',
      attr: ['amount:gte:200'],
      limit: 5,
    });
    expect(service.listRuns).toHaveBeenLastCalledWith({
      workflow: 'billing',
      tag: 'etl',
      namespace: 'eu',
      attributes: [{ key: 'amount', op: 'gte', value: 200 }],
      status: 'dead',
      origin: '@acme/billing',
      offset: 0,
      limit: 6,
    });
  });

  it('rejects a malformed cursor, an unknown status and an unreadable attr', async () => {
    const list = tool(fakeService(), 'durable_list_runs');
    await expect(list.run({ cursor: 'abc' })).rejects.toThrow(/"cursor" must be the `next`/);
    await expect(list.run({ cursor: '-1' })).rejects.toThrow(/"cursor"/);
    await expect(list.run({ status: 'sleeping' })).rejects.toThrow(/"status" must be one of/);
    await expect(list.run({ attr: ['amount'] })).rejects.toThrow(/"attr" entries/);
  });
});

describe('durable_get_run', () => {
  it('returns the detail without its validator, or one field', async () => {
    const service = fakeService();
    const get = tool(service, 'durable_get_run');
    expect(await get.run({ id: 'r1' })).toEqual({
      run: { id: 'r1', status: 'failed' },
      steps: [{ seq: 1 }],
    });
    expect(service.getRunDetail).toHaveBeenLastCalledWith('r1', { summarizeFansOver: 50 });
    expect(await get.run({ id: 'r1', field: 'steps', full: true })).toEqual({
      id: 'r1',
      steps: [{ seq: 1 }],
    });
    expect(service.getRunDetail).toHaveBeenLastCalledWith('r1', undefined);
    await expect(get.run({ id: 'r1', field: 'nope' })).rejects.toThrow(
      'run r1 has no field "nope"; fields: run, steps',
    );
    // Inherited members are not fields.
    for (const inherited of ['toString', 'constructor', '__proto__']) {
      await expect(get.run({ id: 'r1', field: inherited })).rejects.toThrow('has no field');
    }
  });

  it('is an error for an unknown id', async () => {
    await expect(tool(fakeService(), 'durable_get_run').run({ id: 'nope' })).rejects.toThrow(
      'run nope not found',
    );
  });
});

describe('durable_list_fan_members', () => {
  it('pages a fan with a cursor and reports its total', async () => {
    const service = fakeService();
    const fan = tool(service, 'durable_list_fan_members');
    const first = (await fan.run({ id: 'r1', group: 'g', limit: 20, failed: true })) as {
      items: unknown[];
      total: number;
      next: string | null;
    };
    expect(first.items).toHaveLength(20);
    expect(first).toMatchObject({ total: 30, next: '20' });
    expect(service.getFanMembers).toHaveBeenLastCalledWith('r1', 'g', {
      offset: 0,
      limit: 20,
      failedOnly: true,
    });
    const second = (await fan.run({ id: 'r1', group: 'g', cursor: '20', limit: 20 })) as {
      items: unknown[];
      next: string | null;
    };
    expect(second.items).toHaveLength(10);
    expect(second.next).toBeNull();
    await expect(fan.run({ id: 'nope', group: 'g' })).rejects.toThrow(
      'fan g of run nope not found',
    );
  });
});

describe('durable_count_runs_by', () => {
  it('sums the console’s (status, origin) counts per status or per origin', async () => {
    const count = tool(fakeService(), 'durable_count_runs_by');
    expect(await count.run({ field: 'status' })).toEqual({
      items: [
        { value: 'pending', count: 7 },
        { value: 'failed', count: 5 },
        { value: 'blocked', count: 1 },
      ],
      next: null,
    });
    expect(await count.run({ field: 'origin', limit: 1 })).toEqual({
      items: [{ value: '@acme/a', count: 10 }],
      next: '1',
    });
  });

  it('pages any other axis through the store', async () => {
    const service = fakeService();
    const count = tool(service, 'durable_count_runs_by');
    expect(await count.run({ field: 'workflow', limit: 2, tag: 'etl' })).toEqual({
      items: [
        { value: 'billing', count: 9 },
        { value: 'emails', count: 4 },
      ],
      next: '2',
    });
    expect(service.runValueFacets).toHaveBeenLastCalledWith(
      { field: 'workflow' },
      { tag: 'etl' },
      { offset: 0, limit: 3 },
    );
    await count.run({ field: 'attributeValue', key: 'region' });
    expect(service.runValueFacets).toHaveBeenLastCalledWith(
      { field: 'attributeValue', key: 'region' },
      {},
      { offset: 0, limit: 21 },
    );
    await expect(count.run({ field: 'attributeValue' })).rejects.toThrow('"key" is required');
    await expect(count.run({ field: 'colour' })).rejects.toThrow(/"field" must be one of/);
  });
});

describe('durable_get_health, durable_list_workers', () => {
  it('summarize backlog, dead and blocked runs and starved queues', async () => {
    expect(await tool(fakeService(), 'durable_get_health').run({})).toEqual({
      topology: { role: 'control-plane' },
      runs: { failed: 5, pending: 7, blocked: 1 },
      backlog: 7,
      dead: 0,
      blocked: 1,
      queues: 3,
      liveWorkers: 1,
      starved: [
        { group: 'send', depth: 9, kind: 'step' },
        { group: 'billing', depth: 4, kind: 'workflow' },
      ],
      healthy: false,
    });
  });

  it('list every worker group in one page', async () => {
    const workers = (await tool(fakeService(), 'durable_list_workers').run({})) as {
      items: unknown[];
      next: unknown;
    };
    expect(workers.items).toHaveLength(3);
    expect(workers.next).toBeNull();
  });
});

describe('durable_list_schedules', () => {
  it('pages with a cursor and passes the filters', async () => {
    const service = fakeService();
    const list = tool(service, 'durable_list_schedules');
    expect(await list.run({ limit: 2, paused: false, workflow: 'nightly' })).toEqual({
      items: [SCHEDULES[0], SCHEDULES[1]],
      next: '2',
    });
    expect(service.listSchedules).toHaveBeenLastCalledWith({
      workflow: 'nightly',
      paused: false,
      offset: 0,
      limit: 3,
    });
    expect(await list.run({ limit: 2, cursor: '2' })).toEqual({
      items: [SCHEDULES[2]],
      next: null,
    });
  });
});

describe('durable_get_run_event', () => {
  it('reads the latest value, null when never published, and not found for an unknown run', async () => {
    const event = tool(fakeService(), 'durable_get_run_event');
    expect(await event.run({ id: 'r1', key: 'progress' })).toEqual({
      id: 'r1',
      key: 'progress',
      value: 0.5,
    });
    expect(await event.run({ id: 'r1', key: 'other' })).toEqual({
      id: 'r1',
      key: 'other',
      value: null,
    });
    await expect(event.run({ id: 'nope', key: 'progress' })).rejects.toThrow('run nope not found');
  });
});

describe('the run actions', () => {
  it('retry one run, or not found', async () => {
    const retry = tool(fakeService(), 'durable_retry_run');
    expect(await retry.run({ id: 'r1' })).toEqual({ runId: 'r1', status: 'pending' });
    await expect(retry.run({ id: 'nope' })).rejects.toThrow('run nope not found');
    await expect(retry.run({ id: 'r3' })).rejects.toThrow('run r3 is running');
  });

  it('report a partial bulk honestly: what applied, what failed, what was skipped', async () => {
    const service = fakeService();
    const retry = tool(service, 'durable_retry_run');
    expect(await retry.run({ ids: ['r1', 'r2', 'r3', 'r4', 'r5'] })).toEqual({
      applied: [
        { runId: 'r1', status: 'pending' },
        { runId: 'r2', status: 'pending' },
      ],
      failed: { id: 'r3', error: 'run r3 is running' },
      skipped: ['r4', 'r5'],
    });
    expect(service.retry).not.toHaveBeenCalledWith('r4');
    expect(await retry.run({ ids: ['r1', 'nope'] })).toEqual({
      applied: [{ runId: 'r1', status: 'pending' }],
      failed: { id: 'nope', error: 'run nope not found' },
      skipped: [],
    });
    expect(await retry.run({ ids: ['r1', 'r2'] })).toEqual({
      applied: [
        { runId: 'r1', status: 'pending' },
        { runId: 'r2', status: 'pending' },
      ],
    });
  });

  it('take id or ids, never both, and at most 100 ids', async () => {
    const cancel = tool(fakeService(), 'durable_cancel_run');
    await expect(cancel.run({})).rejects.toThrow('"id" or "ids" is required');
    await expect(cancel.run({ id: 'r1', ids: ['r2'] })).rejects.toThrow('not both');
    await expect(
      cancel.run({ ids: Array.from({ length: 101 }, (_, i) => `r${i}`) }),
    ).rejects.toThrow('"ids" lists 101 runs; at most 100 per call');
  });

  it('cancel with or without compensation', async () => {
    const service = fakeService();
    const cancel = tool(service, 'durable_cancel_run');
    expect(await cancel.run({ id: 'r1', compensate: true })).toEqual({
      runId: 'r1',
      status: 'cancelled',
    });
    expect(service.cancel).toHaveBeenLastCalledWith('r1', { compensate: true });
    await cancel.run({ id: 'r2' });
    expect(service.cancel).toHaveBeenLastCalledWith('r2', { compensate: false });
    await expect(cancel.run({ id: 'nope' })).rejects.toThrow('run nope not found');
  });

  it('continue tells an unknown run from one not at a breakpoint', async () => {
    const resume = tool(fakeService(), 'durable_continue_run');
    expect(await resume.run({ id: 'r1' })).toEqual({ runId: 'r1', status: 'running' });
    await expect(resume.run({ id: 'r2' })).rejects.toThrow('run r2 is not paused at a breakpoint');
    await expect(resume.run({ id: 'nope' })).rejects.toThrow('run nope not found');
  });

  it('signal parses the payload as JSON and says whether a run took it', async () => {
    const service = fakeService();
    const signal = tool(service, 'durable_signal_run');
    expect(await signal.run({ token: 'tok', payload: '{"approved":true}' })).toEqual({
      delivered: true,
      runId: 'r1',
      status: 'running',
    });
    expect(service.signal).toHaveBeenLastCalledWith('tok', { approved: true });
    expect(await signal.run({ token: 'other' })).toEqual({ delivered: false });
    expect(service.signal).toHaveBeenLastCalledWith('other', null);
    await expect(signal.run({ token: 'tok', payload: 'yes' })).rejects.toThrow(
      /"payload" must be JSON text/,
    );
  });
});

describe('the schedule actions', () => {
  it('trigger now, or not found', async () => {
    const trigger = tool(fakeService(), 'durable_trigger_schedule');
    expect(await trigger.run({ key: 's0' })).toEqual({ runId: 'r9', status: 'pending' });
    await expect(trigger.run({ key: 'nope' })).rejects.toThrow('schedule nope not found');
  });

  it('pause by default, resume with paused: false', async () => {
    const service = fakeService();
    const pause = tool(service, 'durable_pause_schedule');
    expect(await pause.run({ key: 's0' })).toEqual({ id: 's0', paused: true });
    expect(await pause.run({ key: 's0', paused: false })).toEqual({ id: 's0', paused: false });
    expect(service.resumeSchedule).toHaveBeenCalledWith('s0');
  });

  it('a console 404 reads as not found', async () => {
    const service = fakeService();
    service.pauseSchedule.mockRejectedValueOnce(new NotFoundException('gone'));
    await expect(tool(service, 'durable_pause_schedule').run({ key: 'x' })).rejects.toThrow(
      'schedule x not found',
    );
  });
});

// ── registration ─────────────────────────────────────────────────────────────

const TOKEN = 'dev-token-123';

const gateway = {
  topology: () => ({ role: 'control-plane' }),
  async listRuns() {
    return [];
  },
  async runFacets() {
    return [];
  },
  async runValueFacets() {
    return [];
  },
  async workerHealth() {
    return [];
  },
};

@Global()
@Module({ providers: [{ provide: RunGateway, useValue: gateway }], exports: [RunGateway] })
class HostGatewayModule {}

interface Slot {
  version: 1;
  libs: Array<{
    lib: string;
    title: string;
    authorize(context: ExecutionContext): Promise<{ allowed: boolean; caller?: string }>;
    tools: DurableDevTool[];
  }>;
}

let close: (() => Promise<void>) | undefined;

async function boot(dashboard: DynamicModule): Promise<void> {
  @Module({ imports: [HostGatewayModule, dashboard] })
  class AppModule {}
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  close = () => app.close();
}

async function shutdown(): Promise<void> {
  await close?.();
  close = undefined;
}

const slot = () => holder[DEV_TOOLS_SLOT] as Slot | undefined;

function httpContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({}) }),
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('registration in the dev-tools slot', () => {
  beforeEach(() => {
    delete holder[DEV_TOOLS_SLOT];
  });

  afterEach(async () => {
    await shutdown();
  });

  it('registers the durable lib gated by the console’s own authorize, and leaves on close', async () => {
    await boot(DurableDashboardModule.forRoot({ authorize: authorizeByToken({ token: TOKEN }) }));
    const [lib] = slot()?.libs ?? [];
    expect(lib?.lib).toBe('durable');
    expect(lib?.tools).toHaveLength(14);
    const allowed = await lib?.authorize(httpContext({ authorization: `Bearer ${TOKEN}` }));
    expect(allowed).toMatchObject({ allowed: true, caller: expect.stringMatching(/^token:/) });
    expect(await lib?.authorize(httpContext({}))).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
    await shutdown();
    expect(slot()?.libs).toEqual([]);
  });

  it('appends to a slot the agent created', async () => {
    const libs: Slot['libs'] = [];
    holder[DEV_TOOLS_SLOT] = {
      version: 1,
      libs,
      register(lib: Slot['libs'][number]) {
        libs.push(lib);
        return () => libs.splice(libs.indexOf(lib), 1);
      },
    };
    await boot(DurableDashboardModule.forRoot({ authorize: () => true }));
    expect(libs.map((l) => l.lib)).toEqual(['durable']);
  });

  it('leaves a slot of another version alone', async () => {
    holder[DEV_TOOLS_SLOT] = { version: 2, libs: [] };
    await boot(DurableDashboardModule.forRoot({ authorize: () => true }));
    expect(slot()?.libs).toEqual([]);
  });

  it('is off with routes: false unless devTools: true, and off with devTools: false', async () => {
    await boot(DurableDashboardModule.forRoot({ routes: false, authorize: () => true }));
    expect(slot()?.libs ?? []).toEqual([]);
    await shutdown();

    await boot(
      DurableDashboardModule.forRoot({ routes: false, devTools: true, authorize: () => true }),
    );
    expect(slot()?.libs.map((l) => l.lib)).toEqual(['durable']);
    await shutdown();

    await boot(DurableDashboardModule.forRoot({ devTools: false, authorize: () => true }));
    expect(slot()?.libs ?? []).toEqual([]);
  });
});
