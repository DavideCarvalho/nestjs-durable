import {
  InMemoryStateStore,
  WorkflowEngine,
  clearDurableExecutionWrappers,
  lifecycleRunId,
  runCompletedEvent,
} from '@dudousxd/nestjs-durable-core';
import type { RecordInput, WatcherContext } from '@dudousxd/nestjs-telescope';
import { type SpanOptions, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSpanContext, runTraceId } from './durable-run-trace';
import { DurableTelescopeWatcher } from './durable-telescope.watcher';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function fakeCtx(engine: WorkflowEngine, records: RecordInput[]): WatcherContext {
  return {
    record: (input: RecordInput) => records.push(input),
    runInBatch: async (_origin, fn) => fn(),
    beginBatch: () => ({ id: 'b', end: () => {} }),
    config: {} as WatcherContext['config'],
    moduleRef: { get: () => engine } as unknown as WatcherContext['moduleRef'],
  };
}

async function poll(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('poll timed out');
}

/** An engine whose `ingest` settling starts `refresh`, with a run trace provider installed. */
function lifecyclePair() {
  const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
  engine.setRunTraceparent(() => `00-${TRACE_ID}-00f067aa0ba902b7-01`);
  engine.register('ingest', '1', async () => 'ok');
  engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
  return engine;
}

const started = lifecycleRunId('i1', 'completed', 'refresh');
const entryOf = (records: RecordInput[], event: string, runId: string) =>
  records.find(
    (r) =>
      (r.content as { event: string; runId: string }).event === event &&
      (r.content as { runId: string }).runId === runId,
  );

describe('DurableTelescopeWatcher and lifecycle events', () => {
  afterEach(() => {
    clearDurableExecutionWrappers();
    vi.restoreAllMocks();
  });

  it('records triggered events with a family, and tags a lifecycle-started run with its source', async () => {
    const engine = lifecyclePair();
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));

    await engine.start('ingest', {}, 'i1');
    await poll(() => entryOf(records, 'run.completed', started) !== undefined);

    expect(entryOf(records, 'run.triggered', 'i1')?.familyHash).toBe('durable:run.triggered');
    const start = entryOf(records, 'run.started', started);
    expect(start?.tags).toEqual(
      expect.arrayContaining(['lifecycle', 'source:i1', `sourceTrace:${TRACE_ID}`]),
    );
    expect(start?.content).toMatchObject({
      lifecycleSourceRunId: 'i1',
      lifecycleKind: 'completed',
      lifecycleSourceTraceId: runTraceId('i1'),
    });
    expect(entryOf(records, 'run.started', 'i1')?.tags).not.toContain('lifecycle');
  });

  it('records the started run under a span linked to its source run trace', async () => {
    const spans: { name: string; options: SpanOptions | undefined }[] = [];
    const real = trace.getTracer('test');
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan: (
        name: string,
        options?: SpanOptions,
        ctx?: Parameters<typeof real.startSpan>[2],
      ) => {
        spans.push({ name, options });
        return real.startSpan(name, options, ctx);
      },
      startActiveSpan: real.startActiveSpan.bind(real),
    } as unknown as ReturnType<typeof trace.getTracer>);
    const engine = lifecyclePair();
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));

    await engine.start('ingest', {}, 'i1');
    await poll(() => entryOf(records, 'run.started', started) !== undefined);

    expect(spans).toContainEqual({
      name: 'run refresh',
      options: {
        attributes: {
          'durable.run_id': started,
          'durable.lifecycle.source_run_id': 'i1',
          'durable.lifecycle.kind': 'completed',
        },
        links: [{ context: runSpanContext('i1') }],
      },
    });
    expect(entryOf(records, 'run.started', started)?.traceId).toBe(runTraceId(started));
  });

  it('tags a trigger failure with its subscriber', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('picky', '1', async () => 'ok', {
      onEvent: [
        {
          event: runCompletedEvent('ingest'),
          where: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const records: RecordInput[] = [];
    new DurableTelescopeWatcher().register(fakeCtx(engine, records));

    await engine.start('ingest', {}, 'i1');
    await poll(() => entryOf(records, 'run.trigger_failed', 'i1') !== undefined);

    const failed = entryOf(records, 'run.trigger_failed', 'i1');
    expect(failed?.familyHash).toBe('durable:run.trigger_failed');
    expect(failed?.tags).toEqual(expect.arrayContaining(['trigger_failed', 'subscriber:picky']));
  });
});
