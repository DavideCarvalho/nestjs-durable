import type { HistoryEvent, RemoteStepDef, WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import {
  Cancelled,
  NondeterminismError,
  StepFailed,
  Suspend,
  UnsupportedOnThinWorker,
} from './errors';
import { WorkflowContext } from './workflow-context';

/**
 * A typed remote step def used to drive `ctx.call` (the engine's `call` takes a def, not a name).
 * The `input`/`output` zod schemas don't matter for the worker — it only reads `name`/`group` —
 * so we stub them rather than pull zod into the worker's test deps.
 */
const ingest = {
  name: 'ingest',
  group: 'data',
  input: {} as never,
  output: {} as never,
  __remote: true,
} as const satisfies RemoteStepDef<{ a: number }, { rows: number }>;

describe('WorkflowContext.step', () => {
  it('runs the body once and records a recordStep command with the output', async () => {
    const ctx = new WorkflowContext('r1', []);
    let runs = 0;
    const out = await ctx.step('count', async () => {
      runs += 1;
      return runs;
    });
    expect(out).toBe(1);
    expect(runs).toBe(1);
    expect(ctx.commands).toHaveLength(1);
    const cmd = ctx.commands[0];
    expect(cmd.kind).toBe('recordStep');
    if (cmd.kind === 'recordStep') {
      expect(cmd.seq).toBe(0);
      expect(cmd.name).toBe('count');
      expect(cmd.output).toBe(1);
      expect(typeof cmd.startedAt).toBe('number');
      expect(typeof cmd.finishedAt).toBe('number');
    }
  });

  it('replays the recorded value WITHOUT re-running the body', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'step', name: 'count', output: 42 }];
    const ctx = new WorkflowContext('r1', history);
    const out = await ctx.step('count', async () => {
      throw new Error('body must not run on replay');
    });
    expect(out).toBe(42);
    expect(ctx.commands).toHaveLength(0);
  });

  it('records a failed recordStep and throws StepFailed when the body throws', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(
      ctx.step('boom', async () => {
        throw new Error('kaboom');
      }),
    ).rejects.toBeInstanceOf(StepFailed);
    expect(ctx.commands).toHaveLength(1);
    const cmd = ctx.commands[0];
    expect(cmd.kind).toBe('recordStep');
    if (cmd.kind === 'recordStep') {
      expect(cmd.error?.message).toBe('kaboom');
      expect(cmd.output).toBeUndefined();
    }
  });

  it('re-raises StepFailed when replaying a recorded error', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'step', name: 'boom', error: { message: 'boom' } },
    ];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.step('boom', async () => 1)).rejects.toThrow('boom');
  });

  it('captures step body events on the recordStep command', async () => {
    const ctx = new WorkflowContext('r1', []);
    await ctx.step('s', async (log) => {
      log.info('hello');
      log.sub('proc-a', 'ok');
    });
    const cmd = ctx.commands[0];
    expect(cmd.kind).toBe('recordStep');
    if (cmd.kind === 'recordStep') {
      expect(cmd.events).toHaveLength(2);
      expect(cmd.events?.[0].message).toBe('hello');
      expect(cmd.events?.[1].name).toBe('proc-a');
      expect(cmd.events?.[1].status).toBe('ok');
    }
  });
});

describe('WorkflowContext.call', () => {
  it('accepts a RemoteStepDef and emits a call command with its name/group, then suspends', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.call(ingest, { a: 1 })).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([
      { kind: 'call', seq: 0, name: 'ingest', group: 'data', input: { a: 1 } },
    ]);
  });

  it('accepts engine-side admission opts in the signature without changing the command', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(
      ctx.call(ingest, { a: 1 }, { queue: 'q', priority: 5, fairnessKey: 'k', transport: 't' }),
    ).rejects.toBeInstanceOf(Suspend);
    // opts are engine admission concerns — the worker's emitted command is unchanged.
    expect(ctx.commands).toEqual([
      { kind: 'call', seq: 0, name: 'ingest', group: 'data', input: { a: 1 } },
    ]);
  });

  it('replay-returns the recorded result on the next turn', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'call', name: 'ingest', output: { rows: 9 } }];
    const ctx = new WorkflowContext('r1', history);
    expect(await ctx.call(ingest, { a: 1 })).toEqual({ rows: 9 });
    expect(ctx.commands).toHaveLength(0);
  });
});

describe('WorkflowContext.sleep', () => {
  it('parses a duration string to ms and pushes a sleep command, then suspends', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.sleep('30s')).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([{ kind: 'sleep', seq: 0, ms: 30_000 }]);
  });

  it('accepts a raw number of ms', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.sleep(60_000)).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([{ kind: 'sleep', seq: 0, ms: 60_000 }]);
  });

  it('replay-noops when recorded', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'timer' }];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.sleep('1m')).resolves.toBeUndefined();
    expect(ctx.commands).toHaveLength(0);
  });
});

describe('WorkflowContext.waitForSignal', () => {
  it('pushes a waitSignal command and suspends when not delivered', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.waitForSignal('approve')).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([{ kind: 'waitSignal', seq: 0, signal: 'approve' }]);
  });

  it('honours the timeoutMs option best-effort without changing the emitted command or seq', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.waitForSignal('approve', { timeoutMs: 5_000 })).rejects.toBeInstanceOf(
      Suspend,
    );
    // The wire waitSignal has no timeout — the option is accepted but not expressed remotely.
    expect(ctx.commands).toEqual([{ kind: 'waitSignal', seq: 0, signal: 'approve' }]);
  });

  it('consumes a pending signal at this seq', async () => {
    const ctx = new WorkflowContext('r1', [], {
      pendingSignals: [{ seq: 0, signal: 'approve', payload: { by: 'davi' } }],
    });
    expect(await ctx.waitForSignal('approve')).toEqual({ by: 'davi' });
    expect(ctx.commands).toHaveLength(0);
  });

  it('replay-returns the recorded payload', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'signal', name: 'approve', output: { ok: 1 } },
    ];
    const ctx = new WorkflowContext('r1', history);
    expect(await ctx.waitForSignal('approve')).toEqual({ ok: 1 });
  });
});

describe('WorkflowContext.child', () => {
  it('pushes a startChild command and suspends (await-a-child)', async () => {
    const ctx = new WorkflowContext('r1', []);
    await expect(ctx.child('child-wf', { x: 1 })).rejects.toBeInstanceOf(Suspend);
    expect(ctx.commands).toEqual([
      { kind: 'startChild', seq: 0, workflow: 'child-wf', input: { x: 1 } },
    ]);
  });

  it('replay-returns the recorded child output', async () => {
    const history: HistoryEvent[] = [
      { seq: 0, kind: 'child', name: 'child-wf', output: { done: true } },
    ];
    const ctx = new WorkflowContext('r1', history);
    expect(await ctx.child('child-wf', { x: 1 })).toEqual({ done: true });
  });
});

describe('WorkflowContext deterministic sources (now/random/uuid)', () => {
  it('now() records a step and replays the captured value', async () => {
    const ctx = new WorkflowContext('r1', []);
    const t = await ctx.now();
    expect(typeof t).toBe('number');
    const cmd = ctx.commands[0];
    expect(cmd.kind).toBe('recordStep');
    if (cmd.kind === 'recordStep') {
      expect(cmd.name).toBe('now');
      expect(cmd.output).toBe(t);
    }

    // Replay: the recorded value comes back without re-reading the clock.
    const replay = new WorkflowContext('r1', [{ seq: 0, kind: 'step', name: 'now', output: t }]);
    expect(await replay.now()).toBe(t);
    expect(replay.commands).toHaveLength(0);
  });

  it('random() records a step in [0,1) and replays it', async () => {
    const ctx = new WorkflowContext('r1', []);
    const r = await ctx.random();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
    const cmd = ctx.commands[0];
    if (cmd.kind === 'recordStep') expect(cmd.name).toBe('random');

    const replay = new WorkflowContext('r1', [{ seq: 0, kind: 'step', name: 'random', output: r }]);
    expect(await replay.random()).toBe(r);
  });

  it('uuid() records a step and replays the same id', async () => {
    const ctx = new WorkflowContext('r1', []);
    const id = await ctx.uuid();
    expect(typeof id).toBe('string');
    const cmd = ctx.commands[0];
    if (cmd.kind === 'recordStep') expect(cmd.name).toBe('uuid');

    const replay = new WorkflowContext('r1', [{ seq: 0, kind: 'step', name: 'uuid', output: id }]);
    expect(await replay.uuid()).toBe(id);
  });
});

describe('WorkflowContext unsupported ops throw UnsupportedOnThinWorker', () => {
  const ctx = () => new WorkflowContext('r1', []);

  it('transaction', async () => {
    await expect(ctx().transaction('t', async () => 1)).rejects.toBeInstanceOf(
      UnsupportedOnThinWorker,
    );
  });
  it('callEntity', async () => {
    await expect(ctx().callEntity('e', 'k', 'op')).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });
  it('signalEntity', async () => {
    await expect(ctx().signalEntity('e', 'k', 'op')).rejects.toBeInstanceOf(
      UnsupportedOnThinWorker,
    );
  });
  it('continueAsNew', async () => {
    await expect(ctx().continueAsNew({})).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });
  it('sleepUntil', async () => {
    await expect(ctx().sleepUntil(Date.now())).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });
  it('waitForEvent', async () => {
    await expect(ctx().waitForEvent('e')).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });
  it('task', async () => {
    await expect(ctx().task('t', async () => undefined)).rejects.toBeInstanceOf(
      UnsupportedOnThinWorker,
    );
  });
  it('startChild (fire-and-forget)', async () => {
    await expect(ctx().startChild('wf', {})).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });
  it('breakpoint', async () => {
    await expect(ctx().breakpoint('b')).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });
  it('webhook', () => {
    expect(() => ctx().webhook()).toThrow(UnsupportedOnThinWorker);
  });
  it('setEvent', async () => {
    await expect(ctx().setEvent('k', 1)).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });
  it('onUpdate', async () => {
    await expect(ctx().onUpdate('u')).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });
  it('patched', async () => {
    await expect(ctx().patched('p')).rejects.toBeInstanceOf(UnsupportedOnThinWorker);
  });

  it('carries the op name on the error', async () => {
    const err = await ctx()
      .transaction('t', async () => 1)
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedOnThinWorker);
    expect(err.op).toBe('transaction');
    expect(err.message).toContain('thin worker');
  });
});

describe('WorkflowContext conformance to WorkflowCtx', () => {
  it('is structurally assignable to WorkflowCtx (compile-time proof)', () => {
    // If WorkflowContext stopped implementing WorkflowCtx, this assignment would fail to typecheck.
    const c: WorkflowCtx = new WorkflowContext('r1', []);
    expect(c.runId).toBe('r1');
  });
});

describe('WorkflowContext determinism', () => {
  it('raises NondeterminismError on a kind mismatch at a seq', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'timer' }];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.call(ingest, { a: 1 })).rejects.toBeInstanceOf(NondeterminismError);
  });

  it('raises NondeterminismError on a name mismatch at a seq', async () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'call', name: 'other', output: 1 }];
    const ctx = new WorkflowContext('r1', history);
    await expect(ctx.call(ingest, { a: 1 })).rejects.toBeInstanceOf(NondeterminismError);
  });
});

describe('WorkflowContext cancellation', () => {
  it('throws Cancelled at the op boundary when the run is cancelled', async () => {
    const ctx = new WorkflowContext('r1', [], { isCancelled: (id) => id === 'r1' });
    await expect(ctx.step('s', async () => 1)).rejects.toBeInstanceOf(Cancelled);
  });
});

describe('WorkflowContext.replayEntry', () => {
  it('returns the raw entry without raising on a recorded error', () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'step', name: 's', error: { message: 'x' } }];
    const ctx = new WorkflowContext('r1', history);
    const ev = ctx.replayEntry(0, 'step', 's');
    expect(ev?.error?.message).toBe('x');
  });

  it('returns null when absent', () => {
    const ctx = new WorkflowContext('r1', []);
    expect(ctx.replayEntry(0, 'step', 's')).toBeNull();
  });

  it('still enforces the kind/name guard', () => {
    const history: HistoryEvent[] = [{ seq: 0, kind: 'timer' }];
    const ctx = new WorkflowContext('r1', history);
    expect(() => ctx.replayEntry(0, 'step', 's')).toThrow(NondeterminismError);
  });
});
