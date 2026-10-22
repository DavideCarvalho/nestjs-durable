import type { OnErrorInput, WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { OnError } from './decorators';

// Compile-time only: an `@OnError` method must take `run`'s input and return what `run` returns.

interface Line {
  n: number;
}
type LineResult = { ok: number; failed: number };

export class LineChecks {
  async run(_ctx: WorkflowCtx, _input: Line): Promise<LineResult> {
    return { ok: 1, failed: 0 };
  }

  @OnError('a')
  async ok(_ctx: WorkflowCtx, failure: OnErrorInput<Line>): Promise<LineResult> {
    return { ok: failure.input.n, failed: 1 };
  }

  @OnError()
  async withoutFailure(): Promise<LineResult> {
    return { ok: 0, failed: 1 };
  }

  // @ts-expect-error — returns something `run`'s output type does not allow
  @OnError('b')
  async wrongOutput(): Promise<string> {
    return 'nope';
  }

  // @ts-expect-error — `failure.input` is not `run`'s input
  @OnError('c')
  async wrongInput(_ctx: WorkflowCtx, _failure: OnErrorInput<{ other: true }>) {
    return { ok: 0, failed: 1 };
  }
}
