import { describe, expect, it } from 'vitest';
import { type StartRunDeps, startRun } from './redis-runner';

/**
 * P4.3 — `startRun` worker SDK client.
 *
 * Tests use a minimal fake Queue (via the `deps` seam) so no live Redis is needed. The contract
 * under test:
 *   - queue name  : `<effectivePrefix>-start-run`
 *   - job name    : `'startRun'`
 *   - payload     : a StartRunMessage — `{ tenant, workflow, input, runId?, tags? }`
 */

interface CapturedAdd {
  queue: string;
  jobName: string;
  data: unknown;
}

function makeFakeDeps(): { deps: StartRunDeps; captures: CapturedAdd[] } {
  const captures: CapturedAdd[] = [];
  const deps: StartRunDeps = {
    Queue: class {
      constructor(private readonly name: string) {}
      async add(jobName: string, data: unknown): Promise<void> {
        captures.push({ queue: this.name, jobName, data });
      }
      async close(): Promise<void> {}
    },
  };
  return { deps, captures };
}

describe('startRun — queue name derivation', () => {
  it('uses <prefix>-start-run with default prefix', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun({}, { tenant: 'acme', workflow: 'checkout', input: null, deps });
    expect(captures[0]?.queue).toBe('durable-start-run');
  });

  it('honours a custom prefix', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun({}, { tenant: 'acme', workflow: 'checkout', input: null, prefix: 'flip', deps });
    expect(captures[0]?.queue).toBe('flip-start-run');
  });

  it('folds a non-default namespace into the prefix', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun(
      {},
      { tenant: 'dev-alice', workflow: 'wf', input: null, namespace: 'dev-alice', deps },
    );
    expect(captures[0]?.queue).toBe('durable-dev-alice-start-run');
  });

  it('"default" namespace stays byte-identical to the bare prefix', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun({}, { tenant: 'acme', workflow: 'wf', input: null, namespace: 'default', deps });
    expect(captures[0]?.queue).toBe('durable-start-run');
    expect(captures[0]?.queue).not.toContain('default');
  });

  it('combines custom prefix and non-default namespace', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun(
      {},
      {
        tenant: 'dev-bob',
        workflow: 'wf',
        input: null,
        prefix: 'flip',
        namespace: 'dev-bob',
        deps,
      },
    );
    expect(captures[0]?.queue).toBe('flip-dev-bob-start-run');
  });
});

describe('startRun — wire payload', () => {
  it('enqueues a StartRunMessage with required fields', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun({}, { tenant: 'acme', workflow: 'checkout', input: { qty: 3 }, deps });
    expect(captures[0]?.jobName).toBe('startRun');
    expect(captures[0]?.data).toEqual({ tenant: 'acme', workflow: 'checkout', input: { qty: 3 } });
  });

  it('includes runId when provided', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun({}, { tenant: 'acme', workflow: 'wf', input: null, runId: 'run-123', deps });
    expect(captures[0]?.data).toMatchObject({ runId: 'run-123' });
  });

  it('includes tags when provided', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun(
      {},
      { tenant: 'acme', workflow: 'wf', input: null, tags: ['batch', 'high-priority'], deps },
    );
    expect(captures[0]?.data).toMatchObject({ tags: ['batch', 'high-priority'] });
  });

  it('omits runId and tags when not provided (clean minimal message)', async () => {
    const { deps, captures } = makeFakeDeps();
    await startRun({}, { tenant: 'acme', workflow: 'wf', input: 'hello', deps });
    const data = captures[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('runId');
    expect(data).not.toHaveProperty('tags');
  });

  it('passes the exact input value (complex object) verbatim', async () => {
    const { deps, captures } = makeFakeDeps();
    const input = { orderId: 'o-1', lines: [{ sku: 'x', qty: 2 }] };
    await startRun({}, { tenant: 'acme', workflow: 'invoice', input, deps });
    expect((captures[0]?.data as Record<string, unknown>).input).toEqual(input);
  });
});
