import type {
  HistoryEvent,
  StepCheckpoint,
  WorkflowCommand,
  WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import {
  InMemoryStateStore,
  InMemoryTransport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { WorkflowContext } from './workflow-context';
import { WorkflowWorker } from './workflow-worker';

// ---------------------------------------------------------------------------
// Uniform dispatch (Phase 3): ONE context contract, two runtimes that must agree.
//
// A `@Workflow` body is written ONCE against the engine's `WorkflowCtx` interface, but it can be
// executed by EITHER of two genuinely different runtimes:
//
//   - INLINE  (`createWorkflowCtx`, packages/core): store-coupled. Each op reads/writes checkpoints
//     directly against the `StateStore` and suspends by throwing `WorkflowSuspended`. The engine
//     runs the body in-process.
//   - REPLAY  (`WorkflowContext`, this package): store-LESS. Each op reads from an in-memory history
//     map and emits a `WorkflowCommand`; it suspends by throwing `Suspend`. A worker replays the
//     body and hands the engine the commands, which the engine applies durably.
//
// These two implementations cannot be collapsed into one (one IS the orchestrator-embedded
// store-coupled runtime, the other IS the thin wire/replay runtime) — but they MUST implement the
// SAME `WorkflowCtx` contract identically where it is observable, or a run checkpointed on one and
// resumed on the other would corrupt. The two invariants that make that safe are:
//
//   1. SURFACE  — every member of `WorkflowCtx` exists on `WorkflowContext`. (The drift that broke
//      `durable-worker.module.ts:76`: `ctx.upsertSearchAttributes` was added to the inline contract
//      but a downstream consumer saw a stale build of the replay runtime missing it.)
//   2. SEQ/SHAPE — both runtimes allocate the SAME logical seq to the SAME op in the SAME order, and
//      record the SAME (seq, name, output) for a local step. This is the determinism anchor a
//      cross-runtime resume relies on.
//
// This file PINS both, so a future change to `WorkflowCtx` that only one runtime follows fails here
// (at the worker's OWN test/compile) instead of silently, downstream, against a stale artifact.
// ---------------------------------------------------------------------------

/** Map a replay-runtime {@link WorkflowCommand} onto the {@link HistoryEvent} the engine would persist
 *  for it, so a second replay turn can resume past it — the worker-side twin of the engine's
 *  checkpoint→history projection (`engine.toHistory`). */
function commandToHistory(cmd: WorkflowCommand): HistoryEvent {
  switch (cmd.kind) {
    case 'recordStep':
      return cmd.error != null
        ? { seq: cmd.seq, kind: 'step', name: cmd.name, error: cmd.error }
        : { seq: cmd.seq, kind: 'step', name: cmd.name, output: cmd.output };
    case 'call':
      return { seq: cmd.seq, kind: 'call', name: cmd.name };
    case 'sleep':
      return { seq: cmd.seq, kind: 'timer' };
    case 'waitSignal':
      return { seq: cmd.seq, kind: 'signal' };
    case 'startChild':
      return { seq: cmd.seq, kind: 'child', name: cmd.workflow };
  }
}

/** The (seq, name, output) of every LOCAL step a replay turn recorded — the comparable determinism
 *  fingerprint of a turn, independent of the runtime that produced it. */
function localStepShape(
  commands: WorkflowCommand[],
): Array<{ seq: number; name: string; output: unknown }> {
  return commands
    .filter(
      (cmd): cmd is Extract<WorkflowCommand, { kind: 'recordStep' }> => cmd.kind === 'recordStep',
    )
    .map((cmd) => ({ seq: cmd.seq, name: cmd.name, output: cmd.output }));
}

/** The same fingerprint, read from the engine's persisted INLINE checkpoints (`kind: 'local'`). */
function inlineStepShape(
  checkpoints: StepCheckpoint[],
): Array<{ seq: number; name: string; output: unknown }> {
  return checkpoints
    .filter((cp) => cp.kind === 'local' && cp.status === 'completed')
    .sort((a, b) => a.seq - b.seq)
    .map((cp) => ({ seq: cp.seq, name: cp.name, output: cp.output }));
}

describe('ctx runtime conformance — one WorkflowCtx contract, inline + replay agree', () => {
  it('the replay runtime implements every member of the inline WorkflowCtx surface', async () => {
    // Capture the REAL inline surface: the object the engine hands a body IS the `WorkflowCtx`, so
    // its own keys are the authoritative member list — no hand-maintained list to drift.
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    let inlineSurface: string[] = [];
    engine.register('surface', '1', async (ctx) => {
      inlineSurface = Object.keys(ctx);
      return 0;
    });
    await engine.start('surface', null, 'surface-1');
    await engine.waitForRun('surface-1');
    expect(inlineSurface).toContain('upsertSearchAttributes'); // the member that regressed at :76

    // Every inline member must exist on the replay runtime, or a body written against `WorkflowCtx`
    // would hit `undefined is not a function` (for an op) or read `undefined` (for `runId`) when
    // served by a worker. Member access traverses the prototype, so methods resolve too.
    const replay = new WorkflowContext('r', []) as unknown as Record<string, unknown>;
    const missing = inlineSurface.filter((member) => replay[member] === undefined);
    expect(missing).toEqual([]);
    // The ops (everything but the `runId` value) must specifically be callable.
    const ops = inlineSurface.filter((member) => member !== 'runId');
    const nonCallable = ops.filter((member) => typeof replay[member] !== 'function');
    expect(nonCallable).toEqual([]);
  });

  it('a WorkflowContext instance is assignable to WorkflowCtx (compile-time contract)', () => {
    // This is the structural guard `durable-worker.module.ts:76` relies on: it fails the worker's
    // OWN typecheck the moment `WorkflowContext` stops satisfying `WorkflowCtx`, rather than only a
    // downstream consumer's (which can see a stale build).
    const ctx: WorkflowCtx = new WorkflowContext('r', []);
    expect(ctx.runId).toBe('r');
  });

  it('inline and replay allocate identical seqs and record identical local-step shapes', async () => {
    // One body, both runtimes. Only ops BOTH runtimes support (step + a sleep suspend point), so the
    // comparison is apples-to-apples.
    const body = async (ctx: WorkflowCtx): Promise<unknown> => {
      const a = await ctx.step('alpha', () => 1);
      const b = await ctx.step('beta', () => a + 1);
      await ctx.sleep(5);
      const c = await ctx.step('gamma', () => b + 1);
      return { a, b, c };
    };

    // --- INLINE: run it through the real engine, against a real store, across the suspend. ---
    const store = new InMemoryStateStore();
    let now = 1_000;
    const engine = new WorkflowEngine({
      store,
      transport: new InMemoryTransport(),
      clock: () => now,
    });
    engine.register('parity', '1', body);
    await engine.start('parity', null, 'parity-1');
    // `start` only enqueues (dispatch model); wait for the inline turn to reach its suspend point.
    expect((await engine.waitForRun('parity-1')).status).toBe('suspended');
    now += 1_000_000;
    await engine.resumeDueTimers(now);
    let inlineStatus = '';
    for (let i = 0; i < 200 && inlineStatus !== 'completed'; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      inlineStatus = (await store.getRun('parity-1'))?.status ?? '';
    }
    expect(inlineStatus).toBe('completed');
    const inlineShape = inlineStepShape(await store.listCheckpoints('parity-1'));

    // --- REPLAY: drive the SAME body through the worker, turn by turn, feeding history back. ---
    const worker = new WorkflowWorker('app').register('parity', body);
    const turn1 = await worker.processTask({
      taskId: 't1',
      runId: 'parity-1',
      workflow: 'parity',
      workflowVersion: '1',
      input: null,
      history: [],
      group: 'app',
      attempt: 1,
    });
    expect(turn1.status).toBe('continue'); // suspended on the sleep
    const history = turn1.commands.map(commandToHistory);
    const turn2 = await worker.processTask({
      taskId: 't2',
      runId: 'parity-1',
      workflow: 'parity',
      workflowVersion: '1',
      input: null,
      history,
      group: 'app',
      attempt: 2,
    });
    expect(turn2.status).toBe('completed');
    expect(turn2.output).toEqual({ a: 1, b: 2, c: 3 });
    const replayShape = [...localStepShape(turn1.commands), ...localStepShape(turn2.commands)];

    // The determinism contract: both runtimes assigned seq 0/1 to alpha/beta, seq 2 to the sleep, and
    // seq 3 to gamma (so the replay shape is seqs 0,1,3), with identical names + outputs. A mismatch
    // here is exactly the silent history mis-alignment a cross-runtime resume would suffer.
    expect(replayShape).toEqual([
      { seq: 0, name: 'alpha', output: 1 },
      { seq: 1, name: 'beta', output: 2 },
      { seq: 3, name: 'gamma', output: 3 },
    ]);
    expect(replayShape).toEqual(inlineShape);

    // The sleep took the seq BETWEEN beta and gamma on both runtimes (the 2 vs 3 gap above proves it
    // on replay; the inline run's timer checkpoint pins it on the engine side).
    const inlineSleep = (await store.listCheckpoints('parity-1')).find((cp) => cp.kind === 'sleep');
    expect(inlineSleep?.seq).toBe(2);
    expect(turn1.commands.find((cmd) => cmd.kind === 'sleep')?.seq).toBe(2);
  });

  it('the bounded-wait two-seq rule holds: an unbounded waitForSignal consumes exactly one seq', async () => {
    // The single subtlest determinism rule both runtimes encode: an unbounded `waitForSignal` consumes
    // ONE seq, so the step after it lands on the next seq. (The bounded form consumes TWO — a deadline
    // + a wait — which the replay runtime refuses outright rather than silently shifting every later
    // seq; that refusal is asserted in workflow-context.spec. Here we pin the unbounded arithmetic.)
    const worker = new WorkflowWorker('app').register('waiter', async (ctx: WorkflowCtx) => {
      await ctx.step('before', () => 'b');
      const payload = await ctx.waitForSignal<string>('go');
      const after = await ctx.step('after', () => payload.toUpperCase());
      return after;
    });

    const turn1 = await worker.processTask({
      taskId: 't1',
      runId: 'w1',
      workflow: 'waiter',
      workflowVersion: '1',
      input: null,
      history: [],
      group: 'app',
      attempt: 1,
    });
    expect(turn1.status).toBe('continue');
    // before@0, then the wait@1 — one seq, so `after` will be seq 2.
    expect(localStepShape(turn1.commands)).toEqual([{ seq: 0, name: 'before', output: 'b' }]);
    expect(turn1.commands.find((cmd) => cmd.kind === 'waitSignal')?.seq).toBe(1);

    const turn2 = await worker.processTask({
      taskId: 't2',
      runId: 'w1',
      workflow: 'waiter',
      workflowVersion: '1',
      input: null,
      history: [
        { seq: 0, kind: 'step', name: 'before', output: 'b' },
        { seq: 1, kind: 'signal', output: 'go!' },
      ],
      group: 'app',
      attempt: 2,
    });
    expect(turn2.status).toBe('completed');
    expect(turn2.output).toBe('GO!');
    expect(localStepShape(turn2.commands)).toEqual([{ seq: 2, name: 'after', output: 'GO!' }]);
  });
});
