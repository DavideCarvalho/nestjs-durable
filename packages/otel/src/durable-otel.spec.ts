import {
  FatalError,
  InMemoryStateStore,
  InMemoryTransport,
  LIFECYCLE_TRACE_TAG_PREFIX,
  WorkflowEngine,
  lifecycleRunId,
  runCompletedEvent,
} from '@dudousxd/nestjs-durable-core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { attachDurableOtel } from './durable-otel';

function tracerWithExporter() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { tracer: provider.getTracer('test'), exporter };
}

/** Two engines sharing a store and a broadcast transport: a pod that runs the work and one that only hears it. */
function twoPods() {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  const worker = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    instanceId: 'worker',
  });
  const other = new WorkflowEngine({
    store,
    transport,
    controlPlane: transport,
    instanceId: 'other',
  });
  worker.register('wf', '1', async (ctx) => {
    await ctx.localStep('a', async () => 1);
    return 'ok';
  });
  return { worker, other };
}

async function suspended(store: InMemoryStateStore, runId: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if ((await store.getRun(runId))?.status === 'suspended') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} did not suspend`);
}

describe('attachDurableOtel', () => {
  it('creates a trace per run and a child span per step', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    attachDurableOtel(engine, { tracer });

    engine.register('checkout', '1', async (ctx) => {
      await ctx.localStep('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run1');
    await engine.waitForRun('run1');

    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === 'workflow checkout');
    const step = spans.find((s) => s.name === 'step charge');
    expect(run).toBeDefined();
    expect(step).toBeDefined();
    expect(step?.parentSpanContext?.spanId ?? step?.parentSpanId).toBe(run?.spanContext().spanId);
    expect(run?.attributes['durable.run_id']).toBe('run1');
    expect(step?.attributes['durable.step.kind']).toBe('local');
  });

  it('marks the run span as error when the run fails', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    attachDurableOtel(engine, { tracer });

    engine.register('wf', '1', async (ctx) =>
      ctx.localStep('boom', async () => {
        throw new Error('nope');
      }),
    );
    await engine.start('wf', {}, 'run1');
    await engine.waitForRun('run1');

    const run = exporter.getFinishedSpans().find((s) => s.name === 'workflow wf');
    expect(run?.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('marks the handoff to an onError handler on the run span', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    attachDurableOtel(engine, { tracer });
    engine.register('dlq', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async () => {
        throw new FatalError('bad line', 'invalid_line');
      },
      { onError: [{ code: 'invalid_line', workflow: 'dlq' }] },
    );
    await engine.start('line', {}, 'r');
    await engine.waitForRun('r', { until: 'terminal' });

    const run = exporter.getFinishedSpans().find((s) => s.name === 'workflow line');
    expect(run?.events.find((e) => e.name === 'durable.run.routed')?.attributes).toMatchObject({
      'durable.on_error.handler': 'dlq',
      'durable.error.code': 'invalid_line',
    });
  });

  it("exports a run's spans from the pod that ran it only", async () => {
    const { worker, other } = twoPods();
    const fromWorker = tracerWithExporter();
    const fromOther = tracerWithExporter();
    attachDurableOtel(worker, { tracer: fromWorker.tracer });
    attachDurableOtel(other, { tracer: fromOther.tracer });

    await worker.start('wf', {}, 'run1');
    await worker.waitForRun('run1');

    expect(
      fromWorker.exporter
        .getFinishedSpans()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['step a', 'workflow wf']);
    expect(fromOther.exporter.getFinishedSpans()).toEqual([]);
  });

  it("links a lifecycle subscriber's run span to the run that started it", async () => {
    const { tracer, exporter } = tracerWithExporter();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    attachDurableOtel(engine, { tracer });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });

    await engine.start('ingest', {}, 'i1');
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await engine.waitForRun(started);

    const spans = exporter.getFinishedSpans();
    const source = spans.find((s) => s.name === 'workflow ingest');
    const subscriber = spans.find((s) => s.name === 'workflow refresh');
    expect(subscriber?.links.map((l) => l.context.spanId)).toEqual([source?.spanContext().spanId]);
    expect(subscriber?.links[0]?.context.traceId).toBe(source?.spanContext().traceId);
    expect(subscriber?.attributes).toMatchObject({
      'durable.run_id': started,
      'durable.lifecycle.source_run_id': 'i1',
      'durable.lifecycle.kind': 'completed',
    });
    expect(source?.links).toEqual([]);
    expect(source?.attributes['durable.lifecycle.source_run_id']).toBeUndefined();
  });

  it('links to the source run span from another process, through the traceparent the run recorded', async () => {
    const store = new InMemoryStateStore();
    const settler = new WorkflowEngine({ store, instanceId: 'settler' });
    const subscriberPod = new WorkflowEngine({ store, instanceId: 'subscriber' });
    const fromSettler = tracerWithExporter();
    const fromSubscriber = tracerWithExporter();
    attachDurableOtel(settler, { tracer: fromSettler.tracer });
    attachDurableOtel(subscriberPod, { tracer: fromSubscriber.tracer });
    settler.register('ingest', '1', async () => 'ok');
    // The settler owes the event to `refresh` because the run is marked for it, as a live worker's
    // announcement would make it; only the other pod has the workflow.
    settler.register('placeholder', '1', async () => 'ok', {
      onEvent: [runCompletedEvent('ingest')],
    });
    subscriberPod.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });

    await settler.start('ingest', {}, 'i1');
    await settler.waitForRun(lifecycleRunId('i1', 'completed', 'placeholder'));
    const source = fromSettler.exporter
      .getFinishedSpans()
      .find((s) => s.name === 'workflow ingest');
    const recorded = (await store.getRun('i1'))?.tags?.find((t) =>
      t.startsWith(LIFECYCLE_TRACE_TAG_PREFIX),
    );
    expect(recorded).toBe(
      `${LIFECYCLE_TRACE_TAG_PREFIX}00-${source?.spanContext().traceId}-${source?.spanContext().spanId}-01`,
    );

    expect(
      await subscriberPod.republishLifecycle({ runId: 'i1', subscriber: 'refresh' }),
    ).toMatchObject({
      started: 1,
    });
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await subscriberPod.waitForRun(started);
    const subscriber = fromSubscriber.exporter
      .getFinishedSpans()
      .find((s) => s.name === 'workflow refresh');
    expect(subscriber?.links[0]?.context).toMatchObject({
      traceId: source?.spanContext().traceId,
      spanId: source?.spanContext().spanId,
    });
    expect(subscriber?.attributes['durable.lifecycle.source_run_id']).toBe('i1');
  });

  it('links to the source run span when the run settles in a process that never saw its first turn', async () => {
    const store = new InMemoryStateStore();
    const first = new WorkflowEngine({ store, instanceId: 'first' });
    const resumer = new WorkflowEngine({ store, instanceId: 'resumer' });
    const fromFirst = tracerWithExporter();
    const fromResumer = tracerWithExporter();
    attachDurableOtel(first, { tracer: fromFirst.tracer });
    attachDurableOtel(resumer, { tracer: fromResumer.tracer });
    for (const engine of [first, resumer]) {
      engine.register('ingest', '1', async (ctx) => {
        await ctx.waitForSignal('approve');
        return 'ok';
      });
    }
    // Only the resumer has the subscriber; the first process knows of it from the registry.
    resumer.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await resumer.heartbeatLifecycleRegistry();

    await first.start('ingest', {}, 'i1');
    await suspended(store, 'i1');
    const source = fromFirst.exporter.getFinishedSpans().find((s) => s.name === 'workflow ingest');
    expect((await store.getRun('i1'))?.tags).toEqual([
      `${LIFECYCLE_TRACE_TAG_PREFIX}00-${source?.spanContext().traceId}-${source?.spanContext().spanId}-01`,
    ]);

    await resumer.signal('approve', {});
    const started = lifecycleRunId('i1', 'completed', 'refresh');
    await resumer.waitForRun(started);
    expect(fromResumer.exporter.getFinishedSpans().map((s) => s.name)).not.toContain(
      'workflow ingest',
    );
    const subscriber = fromResumer.exporter
      .getFinishedSpans()
      .find((s) => s.name === 'workflow refresh');
    expect(subscriber?.links[0]?.context).toMatchObject({
      traceId: source?.spanContext().traceId,
      spanId: source?.spanContext().spanId,
    });
    expect(subscriber?.attributes['durable.lifecycle.source_run_id']).toBe('i1');
  });

  it('records no traceparent on the suspend of a run nobody subscribes to', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    attachDurableOtel(engine, tracerWithExporter());
    engine.register('ingest', '1', async (ctx) => ctx.waitForSignal('approve'));
    await engine.start('ingest', {}, 'i1');
    await suspended(store, 'i1');
    expect((await store.getRun('i1'))?.tags ?? []).toEqual([]);
  });

  it('removes its run trace provider when detached', async () => {
    const { tracer } = tracerWithExporter();
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const detach = attachDurableOtel(engine, { tracer });
    detach();
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'ok', { onEvent: [runCompletedEvent('ingest')] });
    await engine.start('ingest', {}, 'i1');
    await engine.waitForRun(lifecycleRunId('i1', 'completed', 'refresh'));
    expect((await store.getRun('i1'))?.tags ?? []).not.toContainEqual(
      expect.stringContaining(LIFECYCLE_TRACE_TAG_PREFIX),
    );
  });
});
