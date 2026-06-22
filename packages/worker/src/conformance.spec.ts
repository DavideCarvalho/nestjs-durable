import {
  InMemoryStateStore,
  InMemoryTransport,
  type RemoteStepDef,
  type WorkflowCommand,
  type WorkflowCtx,
  WorkflowEngine,
  type WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import { z } from 'zod';
import { DurableWorkerRuntime } from './runner-core';

/**
 * Conformance: ONE workflow body, run BOTH ways — in-process on a real `WorkflowEngine` (with an
 * `InMemoryStateStore` + `InMemoryTransport`) and turn-by-turn on the thin {@link DurableWorkerRuntime}
 * — must produce the SAME observable behavior: the same final output and the same ordered
 * `(seq, name, kind)` sequence of recorded steps / remote calls.
 *
 * The body uses both primitives the protocol must agree on: a LOCAL `ctx.step` (recorded on the
 * `recordStep` command / a `local` checkpoint) and a remote `ctx.call` (a `call` command / a `remote`
 * checkpoint). The remote step handler is byte-identical on both sides.
 */

const remoteAdd: RemoteStepDef<{ a: number }, { sum: number }> = {
  name: 'math.add-ten',
  group: 'math',
  input: z.object({ a: z.number() }),
  output: z.object({ sum: z.number() }),
  __remote: true,
};

/** The single workflow body under test. Typed against the engine's `WorkflowCtx`; the thin
 *  `WorkflowContext` `implements WorkflowCtx`, so the very same function runs on both runtimes. */
async function body(ctx: WorkflowCtx, input: { x: number }): Promise<{ a: number; r: number }> {
  const a = await ctx.step('s', async () => input.x * 2);
  const { sum } = await ctx.call(remoteAdd, { a });
  return { a, r: sum };
}

/** The remote step handler — identical logic on both sides (engine transport + thin step worker). */
const addTen = (i: { a: number }): { sum: number } => ({ sum: i.a + 10 });

/** A normalized observable trace of the durable ops a run recorded, ordered by seq. */
type Trace = Array<{ seq: number; name: string; kind: 'local' | 'remote' }>;

async function settle(store: InMemoryStateStore, runId: string) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

/** (A) Drive the body in-process on the engine; return its output + the checkpoint trace. */
async function runOnEngine(input: { x: number }): Promise<{ output: unknown; trace: Trace }> {
  const store = new InMemoryStateStore();
  const transport = new InMemoryTransport();
  transport.handle(remoteAdd.name, async (i: { a: number }) => addTen(i));

  const engine = new WorkflowEngine({ store, transport });
  engine.register('conf', '1', (ctx, i) => body(ctx, i as { x: number }));

  await engine.start('conf', input, 'engine-run');
  const run = await settle(store, 'engine-run');

  const cps = await store.listCheckpoints('engine-run');
  const trace: Trace = cps
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((c) => ({
      seq: c.seq,
      name: c.name ?? '',
      kind: c.kind === 'remote' ? 'remote' : 'local',
    }));
  return { output: run.output, trace };
}

/** (B) Drive the body on the thin worker turn-by-turn — feeding each turn's commands back as the
 *  next turn's history — until the run completes. Returns the final output + the command trace. */
async function runOnThinWorker(input: { x: number }): Promise<{ output: unknown; trace: Trace }> {
  const runtime = new DurableWorkerRuntime();
  runtime.registerWorkflow('conf', (ctx, i) => body(ctx, i as { x: number }));
  runtime.registerStep(remoteAdd.name, async (i) => addTen(i as { a: number }));

  // History accumulates the resolved ops the engine WOULD persist between turns: a local `recordStep`
  // becomes a `step` history event; a remote `call` becomes a `call` event resolved by running the
  // registered step handler (what the engine's transport does for us on side A).
  const history: WorkflowTask['history'] = [];
  const trace: Trace = [];
  let output: unknown;

  for (let turn = 0; turn < 20; turn += 1) {
    const task: WorkflowTask = {
      taskId: `t${turn}`,
      runId: 'thin-run',
      workflow: 'conf',
      workflowVersion: '1',
      input,
      history: history.slice(),
      group: 'math',
      attempt: 1,
    };
    const handled = await runtime.handleTask(task);
    if (handled.kind !== 'decision') throw new Error('expected a workflow decision');
    const decision = handled.decision;

    for (const cmd of decision.commands) applyCommand(cmd, history, trace);

    if (decision.status === 'completed') {
      output = decision.output;
      return { output, trace };
    }
    if (decision.status === 'continue') {
      // Resolve any remote `call` this turn emitted by running the registered step handler (the
      // engine does this via its transport on side A — here we do it to advance the turn).
      for (const cmd of decision.commands) {
        if (cmd.kind === 'call') {
          const stepTask = {
            runId: 'thin-run',
            seq: cmd.seq,
            name: cmd.name,
            stepId: `s${cmd.seq}`,
            group: cmd.group,
            input: cmd.input,
            attempt: 1,
          } as const;
          const res = await runtime.handleTask(stepTask);
          if (res.kind !== 'result') throw new Error('expected a step result');
          const ev = history.find((h) => h.seq === cmd.seq);
          if (ev) ev.output = res.result.output;
        }
      }
      continue;
    }
    throw new Error(`unexpected decision status ${decision.status}`);
  }
  throw new Error('thin worker did not complete within the turn budget');
}

/** Apply one command to the running history + observable trace, mirroring the engine's apply. */
function applyCommand(cmd: WorkflowCommand, history: WorkflowTask['history'], trace: Trace): void {
  if (cmd.kind === 'recordStep') {
    history.push({ seq: cmd.seq, kind: 'step', name: cmd.name, output: cmd.output });
    trace.push({ seq: cmd.seq, name: cmd.name, kind: 'local' });
  } else if (cmd.kind === 'call') {
    // The output is filled in once the step handler resolves (see runOnThinWorker).
    history.push({ seq: cmd.seq, kind: 'call', name: cmd.name });
    trace.push({ seq: cmd.seq, name: cmd.name, kind: 'remote' });
  }
}

describe('conformance — a @Workflow body runs identically on the engine and the thin worker', () => {
  it('produces the SAME final output on both runtimes', async () => {
    const input = { x: 5 };
    const engine = await runOnEngine(input);
    const thin = await runOnThinWorker(input);

    // x*2 = 10 (local step `a`), then +10 remotely = 20.
    expect(engine.output).toEqual({ a: 10, r: 20 });
    expect(thin.output).toEqual(engine.output);
  });

  it('records the SAME ordered (seq, name, kind) sequence of steps/calls on both runtimes', async () => {
    const input = { x: 7 };
    const engine = await runOnEngine(input);
    const thin = await runOnThinWorker(input);

    const expected: Trace = [
      { seq: 0, name: 's', kind: 'local' },
      { seq: 1, name: 'math.add-ten', kind: 'remote' },
    ];
    expect(engine.trace).toEqual(expected);
    expect(thin.trace).toEqual(expected);
    expect(thin.trace).toEqual(engine.trace);
  });
});
