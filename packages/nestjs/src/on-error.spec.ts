import {
  FatalError,
  InMemoryStateStore,
  InMemoryTransport,
  type OnErrorInput,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { OnError, Workflow } from './decorators';
import { DurableModule } from './durable.module';

class InvalidLine extends FatalError {
  static readonly code = 'invalid_line';
  constructor(message: string) {
    super(message, InvalidLine.code);
  }
}

interface Line {
  n: number;
  amount: string;
}
type LineResult = { ok: number; failed: number; reason?: string };

@Injectable()
class DeadLetters {
  readonly stored: { line: Line; error: string; runId: string }[] = [];
}

@Workflow({ name: 'upstream-failure', version: '1' })
class UpstreamFailureWorkflow {
  async run(_ctx: WorkflowCtx, failure: OnErrorInput<Line>): Promise<LineResult> {
    return { ok: 0, failed: 1, reason: `upstream: ${failure.error.message}` };
  }
}

@Workflow({
  name: 'line',
  version: '1',
  onError: [{ code: 'upstream', workflow: UpstreamFailureWorkflow }],
})
class LineWorkflow {
  constructor(private readonly deadLetters: DeadLetters) {}

  async run(ctx: WorkflowCtx, line: Line): Promise<LineResult> {
    await ctx.localStep('parse', async () => {
      if (line.amount === 'x') throw new InvalidLine(`line ${line.n}: amount is not a number`);
      if (line.amount === 'timeout') throw new FatalError('DPAS timed out', 'upstream');
      if (line.amount === 'boom') throw new Error('unexpected');
      return Number(line.amount);
    });
    return { ok: 1, failed: 0 };
  }

  @OnError(InvalidLine)
  async invalid(_ctx: WorkflowCtx, failure: OnErrorInput<Line>): Promise<LineResult> {
    this.deadLetters.stored.push({
      line: failure.input,
      error: failure.error.message,
      runId: failure.runId,
    });
    return { ok: 0, failed: 1 };
  }

  @OnError()
  async other(_ctx: WorkflowCtx, failure: OnErrorInput<Line>): Promise<LineResult> {
    return { ok: 0, failed: 1, reason: failure.error.message };
  }
}

@Workflow({ name: 'file', version: '1' })
class FileWorkflow {
  async run(ctx: WorkflowCtx, input: { amounts: string[] }) {
    return ctx.all(
      LineWorkflow,
      input.amounts.map((amount, n) => ({ n, amount })),
    );
  }
}

async function boot() {
  const store = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport() })],
    providers: [DeadLetters, LineWorkflow, FileWorkflow, UpstreamFailureWorkflow],
  }).compile();
  await moduleRef.init();
  const engine = moduleRef.get(WorkflowEngine);
  const finished = (id: string) => engine.waitForRun(id, { until: 'terminal' });
  return { engine, store, finished, deadLetters: moduleRef.get(DeadLetters) };
}

describe('@OnError', () => {
  it('hands the failure to the method as its own run, with the injected dependencies', async () => {
    const { engine, store, finished, deadLetters } = await boot();
    await engine.start('line', { n: 3, amount: 'x' }, 'r1');
    const run = await finished('r1');

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ ok: 0, failed: 1 });
    expect(deadLetters.stored).toEqual([
      { line: { n: 3, amount: 'x' }, error: 'line 3: amount is not a number', runId: 'r1' },
    ]);
    expect((await store.getRun('r1.onError.0'))?.workflow).toBe('line.onError.invalid');
  });

  it('routes a code from @Workflow({ onError }) to a separate workflow', async () => {
    const { engine, finished } = await boot();
    await engine.start('line', { n: 0, amount: 'timeout' }, 'r1');

    expect((await finished('r1')).output).toEqual({
      ok: 0,
      failed: 1,
      reason: 'upstream: DPAS timed out',
    });
  });

  it('sends any other failure to the catch-all method', async () => {
    const { engine, finished } = await boot();
    await engine.start('line', { n: 1, amount: 'boom' }, 'r1');

    expect((await finished('r1')).output).toEqual({ ok: 0, failed: 1, reason: 'unexpected' });
  });

  it('lets ctx.all over the workflow complete when lines fail', async () => {
    const { engine, finished } = await boot();
    await engine.start('file', { amounts: ['1', 'x', '2'] }, 'f');
    const run = await finished('f');

    expect(run.status).toBe('completed');
    expect(run.output).toEqual([
      { ok: 1, failed: 0 },
      { ok: 0, failed: 1 },
      { ok: 1, failed: 0 },
    ]);
  });

  it('rejects an error class without a static code', () => {
    class NoCode extends Error {}
    expect(() => OnError(NoCode as unknown as { code: string })).toThrow('no static `code`');
  });
});
