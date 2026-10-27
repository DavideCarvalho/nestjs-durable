import {
  FatalError,
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
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
});
