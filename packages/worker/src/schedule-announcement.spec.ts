import { describe, expect, it } from 'vitest';
import { buildRunnerDescriptor } from './redis-runner';
import { DurableWorkerRuntime } from './runner-core';

describe('the runner descriptor announces the app schedules', () => {
  it('carries the announcement when given, and nothing when not', () => {
    const runtime = new DurableWorkerRuntime();
    runtime.registerWorkflow('digest', async () => 'ok');
    const announced = buildRunnerDescriptor(runtime, 'w-1', 'acme', 5, {
      tenant: 'acme',
      items: [{ key: 'daily', workflow: 'digest', everyMs: 60_000 }],
    });
    expect(announced.schedules).toEqual({
      tenant: 'acme',
      items: [{ key: 'daily', workflow: 'digest', everyMs: 60_000 }],
    });
    expect('schedules' in buildRunnerDescriptor(runtime, 'w-1', 'acme', 5)).toBe(false);
  });
});
