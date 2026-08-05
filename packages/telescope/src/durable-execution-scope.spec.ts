import type { DurableExecution } from '@dudousxd/nestjs-durable-core';
import type { BatchOrigin, WatcherContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import {
  currentDurableScope,
  durableExecutionScope,
  durableTraceContext,
} from './durable-execution-scope';
import { runTraceId } from './durable-run-trace';

/** A `WatcherContext` whose `runInBatch` mints a batch id per call, so a test can see re-use. */
function fakeCtx(options: { enabled?: boolean } = {}) {
  const batches: string[] = [];
  let n = 0;
  const ctx: WatcherContext = {
    record: () => {},
    runInBatch: async <T>(origin: BatchOrigin, fn: () => Promise<T>) => {
      n += 1;
      batches.push(`${origin}:${n}`);
      return fn();
    },
    beginBatch: () => ({ id: 'b', end: () => {} }),
    config: { enabled: options.enabled ?? true } as WatcherContext['config'],
    moduleRef: {} as WatcherContext['moduleRef'],
  };
  return { ctx, batches };
}

const turn = (runId: string): DurableExecution => ({
  unit: 'workflow',
  runId,
  workflow: 'w',
  name: undefined,
  seq: undefined,
  attempt: undefined,
});

const step = (runId: string, name: string): DurableExecution => ({
  unit: 'step',
  runId,
  workflow: undefined,
  name,
  seq: 0,
  attempt: 1,
});

describe('durableExecutionScope', () => {
  it("opens a 'queue' batch around the body", async () => {
    const { ctx, batches } = fakeCtx();
    const scope = durableExecutionScope(ctx);

    let inside: string | undefined;
    await scope(turn('r1'), async () => {
      inside = currentDurableScope()?.runId;
      return null;
    });

    expect(batches).toEqual(['queue:1']);
    expect(inside).toBe('r1');
  });

  it('reuses the open batch for a step of the SAME run — the in-process nesting case', async () => {
    const { ctx, batches } = fakeCtx();
    const scope = durableExecutionScope(ctx);

    const seenSpans: Array<string | undefined> = [];
    await scope(turn('r1'), async () => {
      seenSpans.push(currentDurableScope()?.spanId);
      // A dispatched step whose handler starts inside the dispatching turn's async context.
      await scope(step('r1', 'charge'), async () => {
        seenSpans.push(currentDurableScope()?.spanId);
        return null;
      });
      return null;
    });

    expect(batches).toEqual(['queue:1']);
    // Reuse means exactly that: the same scope, so the same span too.
    expect(seenSpans[0]).toBe(seenSpans[1]);
  });

  it('opens a fresh batch for a DIFFERENT run — a child workflow keeps its own boundaries', async () => {
    const { ctx, batches } = fakeCtx();
    const scope = durableExecutionScope(ctx);

    const traces: Array<string | undefined> = [];
    await scope(turn('parent'), async () => {
      traces.push(currentDurableScope()?.traceId);
      await scope(turn('child'), async () => {
        traces.push(currentDurableScope()?.traceId);
        return null;
      });
      return null;
    });

    expect(batches).toEqual(['queue:1', 'queue:2']);
    expect(traces).toEqual([runTraceId('parent'), runTraceId('child')]);
  });

  it('does not offer reuse across two independent Telescope wirings', async () => {
    // Two wrappers, e.g. a torn-down test module whose wrapper outlived it plus the live one. The
    // second must still open ITS OWN batch, or its console records everything batchless.
    const first = fakeCtx();
    const second = fakeCtx();
    const outer = durableExecutionScope(first.ctx);
    const inner = durableExecutionScope(second.ctx);

    await outer(turn('r1'), () => inner(turn('r1'), async () => null));

    expect(first.batches).toEqual(['queue:1']);
    expect(second.batches).toEqual(['queue:1']);
  });

  it('costs nothing when Telescope is disabled', async () => {
    const { ctx, batches } = fakeCtx({ enabled: false });
    const scope = durableExecutionScope(ctx);

    let inside: unknown;
    await scope(turn('r1'), async () => {
      inside = currentDurableScope();
      return null;
    });

    expect(batches).toEqual([]);
    expect(inside).toBeUndefined();
  });

  it('re-throws the body error rather than swallowing it', async () => {
    const { ctx } = fakeCtx();
    const scope = durableExecutionScope(ctx);

    await expect(
      scope(turn('r1'), async () => {
        throw new Error('step exploded');
      }),
    ).rejects.toThrow('step exploded');
  });

  it('still runs the work when opening the scope fails', async () => {
    const ctx: WatcherContext = {
      record: () => {},
      runInBatch: () => {
        throw new Error('telescope is wedged');
      },
      beginBatch: () => ({ id: 'b', end: () => {} }),
      config: { enabled: true } as WatcherContext['config'],
      moduleRef: {} as WatcherContext['moduleRef'],
    };

    await expect(durableExecutionScope(ctx)(turn('r1'), async () => 'ran anyway')).resolves.toBe(
      'ran anyway',
    );
  });
});

describe('durableTraceContext', () => {
  it('reports the active scope so other watchers inherit the run trace', async () => {
    const { ctx } = fakeCtx();
    const scope = durableExecutionScope(ctx);
    const traceContext = durableTraceContext();

    expect(traceContext.current()).toBeNull();
    await scope(turn('r1'), async () => {
      const current = traceContext.current();
      expect(current?.traceId).toBe(runTraceId('r1'));
      expect(current?.spanId).toMatch(/^[0-9a-f]{16}$/);
      return null;
    });
    expect(traceContext.current()).toBeNull();
  });

  it("lets the host's own tracing win where it has an answer", async () => {
    const { ctx } = fakeCtx();
    const scope = durableExecutionScope(ctx);
    const traceContext = durableTraceContext({
      current: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    });

    await scope(turn('r1'), async () => {
      expect(traceContext.current()?.traceId).toBe('a'.repeat(32));
      return null;
    });
  });
});
