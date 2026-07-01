import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableStartClient } from './durable-start-client';

@Workflow({ name: 'demo', version: '1' })
class DemoWorkflow {
  run() {
    return null;
  }
}

function makeFakeQueue(sink: { name: string; data: unknown }[]) {
  return class {
    constructor(
      private readonly _name: string,
      private readonly _opts: Record<string, unknown>,
    ) {}
    async add(name: string, data: unknown) {
      sink.push({ name, data });
      return undefined;
    }
    async close() {}
  };
}

describe('DurableStartClient', () => {
  it('dispatches a start-run message stamped with tenant, workflow name, input, runId, and searchAttributes', async () => {
    const sink: { name: string; data: unknown }[] = [];
    const client = new DurableStartClient(
      { connection: 'redis://x', groups: ['pipeline'], tenant: 'davi-local' },
      { Queue: makeFakeQueue(sink) },
    );

    const result = await client.start(DemoWorkflow, { n: 1 }, 'run-1', {
      tags: ['t'],
      searchAttributes: { tier: 'pro' },
    });

    expect(result).toEqual({ runId: 'run-1', status: 'pending' });
    expect(sink).toHaveLength(1);
    expect(sink[0].name).toBe('startRun');
    expect(sink[0].data).toMatchObject({
      tenant: 'davi-local',
      workflow: 'demo',
      input: { n: 1 },
      runId: 'run-1',
      tags: ['t'],
      searchAttributes: { tier: 'pro' },
    });
  });

  it('mints a runId when the caller omits one and returns it', async () => {
    const sink: { name: string; data: unknown }[] = [];
    const client = new DurableStartClient(
      { connection: 'redis://x', groups: ['pipeline'], tenant: 'davi-local' },
      { Queue: makeFakeQueue(sink) },
    );
    const result = await client.start(DemoWorkflow, { n: 2 });
    expect(result.status).toBe('pending');
    expect(result.runId).toMatch(/[0-9a-f-]{36}/);
    expect((sink[0].data as { runId: string }).runId).toBe(result.runId);
  });

  it('falls back to the default tenant when none is configured', async () => {
    const sink: { name: string; data: unknown }[] = [];
    const client = new DurableStartClient(
      { connection: 'redis://x', groups: ['pipeline'] },
      { Queue: makeFakeQueue(sink) },
    );
    await client.start(DemoWorkflow, { n: 3 }, 'r3');
    expect((sink[0].data as { tenant: string }).tenant).toBe('default');
  });

  it('throws on cancel and deleteRun (no store on a tenant)', async () => {
    const client = new DurableStartClient(
      { connection: 'redis://x', groups: ['pipeline'], tenant: 'davi-local' },
      { Queue: makeFakeQueue([]) },
    );
    await expect(client.cancel('r1')).rejects.toThrow(/tenant/i);
    await expect(client.deleteRun('r1')).rejects.toThrow(/tenant/i);
  });
});
