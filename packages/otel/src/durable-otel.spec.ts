import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
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

describe('attachDurableOtel', () => {
  it('creates a trace per run and a child span per step', async () => {
    const { tracer, exporter } = tracerWithExporter();
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    attachDurableOtel(engine, { tracer });

    engine.register('checkout', '1', async (ctx) => {
      await ctx.step('charge', async () => 1);
      return 'ok';
    });
    await engine.start('checkout', {}, 'run1');

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
      ctx.step('boom', async () => {
        throw new Error('nope');
      }),
    );
    await engine.start('wf', {}, 'run1');

    const run = exporter.getFinishedSpans().find((s) => s.name === 'workflow wf');
    expect(run?.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});
