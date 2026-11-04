import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { FatalError } from './errors';
import { lifecycleRunId, runCompletedEvent } from './lifecycle-events';
import { collectMetrics } from './metrics';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';

describe('collectMetrics', () => {
  it('counts run/step outcomes and per-workflow runs from engine events', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = collectMetrics(engine);

    engine.register('ok', '1', async (ctx) => {
      await ctx.localStep('a', async () => 1);
      return 'done';
    });
    engine.register('bad', '1', async () => {
      throw new Error('boom');
    });

    await startRun(engine, 'ok', {}, 'r1');
    await startRun(engine, 'bad', {}, 'r2');

    const s = metrics.snapshot();
    expect(s.runs.started).toBe(2);
    expect(s.runs.completed).toBe(1);
    expect(s.runs.failed).toBe(1);
    expect(s.steps.completed).toBe(1);
    expect(s.byWorkflow.ok).toEqual({ started: 1, completed: 1, failed: 0 });
    expect(s.byWorkflow.bad?.failed).toBe(1);

    const prom = metrics.prometheus();
    expect(prom).toContain('durable_runs_total{event="completed"} 1');
    expect(prom).toContain('durable_runs_by_workflow_total{workflow="ok",event="completed"} 1');

    metrics.stop();
  });

  it('counts failures handed to an onError handler, and exposes them by code', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = collectMetrics(engine);
    engine.register('dlq', '1', async () => 'handled');
    engine.register(
      'line',
      '1',
      async () => {
        throw new FatalError('bad line', 'invalid_line');
      },
      { onError: [{ code: 'invalid_line', workflow: 'dlq' }] },
    );

    await startRun(engine, 'line', {}, 'r');
    await engine.waitForRun('r', { until: 'terminal' });

    expect(metrics.snapshot().runs.routed).toBe(1);
    expect(metrics.snapshot().routedByCode).toEqual({ invalid_line: 1 });
    expect(metrics.prometheus()).toContain('durable_runs_routed_total{code="invalid_line"} 1');
    metrics.stop();
  });

  it('counts the subscriber runs a settled run started, by workflow and subscriber', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = collectMetrics(engine);
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    await engine.start('ingest', {}, 'i1');
    await engine.waitForRun(lifecycleRunId('i1', 'completed', 'refresh'));

    expect(metrics.snapshot().triggeredBySubscriber).toEqual({ ingest: { refresh: 1 } });
    expect(metrics.prometheus()).toContain(
      'durable_runs_triggered_total{workflow="ingest",subscriber="refresh"} 1',
    );
  });

  it('counts the subscribers a settled run could not start, by workflow and subscriber', async () => {
    const engine = new WorkflowEngine({ store: new InMemoryStateStore() });
    const metrics = collectMetrics(engine);
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
    await engine.start('ingest', {}, 'i1');
    await engine.waitForRun('i1', { until: 'terminal' });
    for (let i = 0; i < 50 && !metrics.snapshot().triggerFailedBySubscriber.ingest; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(metrics.snapshot().triggerFailedBySubscriber).toEqual({ ingest: { picky: 1 } });
    expect(metrics.prometheus()).toContain(
      'durable_runs_trigger_failed_total{workflow="ingest",subscriber="picky"} 1',
    );
  });
});
