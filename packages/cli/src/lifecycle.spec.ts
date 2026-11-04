import {
  InMemoryStateStore,
  WorkflowEngine,
  runCompletedEvent,
} from '@dudousxd/nestjs-durable-core';
import { republishLifecycle, republishTarget } from './lifecycle';

describe('lifecycle:republish', () => {
  it('builds the engine target from the flags', () => {
    expect(republishTarget({ run: 'i1', subscriber: 'refresh' })).toEqual({
      runId: 'i1',
      subscriber: 'refresh',
    });
    expect(
      republishTarget({ workflow: 'ingest', since: '2026-01-01T00:00:00Z', until: '2026-02-01' }),
    ).toEqual({
      workflow: 'ingest',
      since: new Date('2026-01-01T00:00:00Z'),
      until: new Date('2026-02-01'),
    });
    expect(() => republishTarget({})).toThrow('Pass --run <runId> or --workflow <name>.');
    expect(() => republishTarget({ run: 'a', workflow: 'b' })).toThrow('not both');
    expect(() => republishTarget({ workflow: 'ingest', since: 'yesterday' })).toThrow(
      'Invalid --since date "yesterday".',
    );
  });

  it('backfills a subscriber and reports what it started', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('ingest', '1', async () => 'ok');
    await engine.start('ingest', {}, 'i1');
    await engine.waitForRun('i1');
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    engine.register('strict', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest')],
      validateInput: () => {
        throw new Error('bad input');
      },
    });

    expect(await republishLifecycle(engine, { workflow: 'ingest' })).toBe(
      'Republished 1 run: started 1 subscriber run, 1 failed.\n  i1 → strict: bad input',
    );
    expect(await republishLifecycle(engine, { run: 'i1', subscriber: 'refresh' })).toBe(
      'Republished 1 run: started 0 subscriber runs, 0 failed.',
    );
  });
});
