import { WorkflowEngine } from './engine';
import type {
  Heartbeat,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowRun,
  WorkflowTask,
} from './interfaces';
import { startRun } from './test-helpers';
import { InMemoryStateStore } from './testing/in-memory-state-store';
import { InMemoryTransport } from './testing/in-memory-transport';

/**
 * `StartOptions.version` — starting an EXACT registered version instead of whatever is newest.
 *
 * Every case here asserts the BODY that ran (or the version the dispatched task carries), never that
 * the option was merely accepted: "start took a version argument" is true of a `start` that ignores
 * it, so it proves nothing. `latest` remains the default, an unknown version fails BEFORE a run row
 * exists, and the two synthesized registration paths (remote-ancestor inheritance, convention
 * routing) refuse a pin rather than inventing a version that nothing has verified.
 */

async function settle(store: InMemoryStateStore, runId: string): Promise<WorkflowRun> {
  for (let i = 0; i < 200; i += 1) {
    await new Promise((r) => setImmediate(r));
    const run = await store.getRun(runId);
    if (run && run.status !== 'running' && run.status !== 'suspended' && run.status !== 'pending') {
      return run;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

/** A transport with a live `legacy` worker group, so convention routing can resolve it. Records the
 *  workflow tasks it was handed and completes each run, like a worker that replies immediately. */
class LiveGroupTransport implements Transport {
  readonly tasks: WorkflowTask[] = [];
  private decisionHandler?: (decision: WorkflowDecision) => Promise<void>;

  async dispatch(): Promise<void> {}
  onResult(_handler: (result: StepResult) => Promise<void>): void {}
  onHeartbeat(_handler: (beat: Heartbeat) => Promise<void>): void {}

  async listWorkerGroups(): Promise<string[]> {
    return ['legacy'];
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    this.tasks.push(task);
    const decision: WorkflowDecision = {
      taskId: task.taskId,
      runId: task.runId,
      status: 'completed',
      commands: [],
      output: { servedVersion: task.workflowVersion },
    };
    setImmediate(() => void this.decisionHandler?.(decision));
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionHandler = handler;
  }
}

describe('WorkflowEngine.start — targeting a version', () => {
  it('runs the OLDER registered body when pinned to it, and the newest when not', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const ran: string[] = [];
    engine.register('wf', '1', async () => {
      ran.push('v1');
      return 'v1-output';
    });
    engine.register('wf', '2', async () => {
      ran.push('v2');
      return 'v2-output';
    });

    const pinned = await startRun(engine, 'wf', {}, 'pinned', { version: '1' });

    // The v1 BODY ran — not merely "the argument was accepted".
    expect(pinned.output).toBe('v1-output');
    expect(ran).toEqual(['v1']);
    // …and the run records v1, so its resume pins there too (replay is positional).
    expect((await store.getRun('pinned'))?.workflowVersion).toBe('1');

    // The default is untouched: no version ⇒ newest.
    const unpinned = await startRun(engine, 'wf', {}, 'unpinned');
    expect(unpinned.output).toBe('v2-output');
    expect((await store.getRun('unpinned'))?.workflowVersion).toBe('2');
  });

  it('still pins the older body when the NEWEST version is registered last (registration order)', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    // Registered newest-first: `latest` tracking and the pin lookup must not depend on call order.
    engine.register('wf', '2', async () => 'v2-output');
    engine.register('wf', '1', async () => 'v1-output');

    expect((await startRun(engine, 'wf', {}, 'r1', { version: '1' })).output).toBe('v1-output');
    expect((await startRun(engine, 'wf', {}, 'r2')).output).toBe('v2-output');
  });

  it('FAILS at start on an unregistered version — never silently falls back to the newest', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    let ranV2 = false;
    engine.register('wf', '2', async () => {
      ranV2 = true;
      return 'v2-output';
    });

    await expect(engine.start('wf', {}, 'gone', { version: '1' })).rejects.toThrow(
      /wf@1 is not registered/,
    );
    // Prevent, not detect: no run row was created, so nothing has to be cancelled afterwards.
    expect(await store.getRun('gone')).toBeNull();
    // And the newest body never ran behind the caller's back.
    expect(ranV2).toBe(false);
  });

  it("names the versions this deploy actually carries, so the error isn't a guessing game", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('wf', '1', async () => 'v1');
    engine.register('wf', '3', async () => 'v3');

    await expect(engine.start('wf', {}, 'r', { version: '2' })).rejects.toThrow(/registered: 1, 3/);
  });

  it('keeps the plain "not registered" error when the NAME is unknown and no version was pinned', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });

    await expect(engine.start('nope', {}, 'r')).rejects.toThrow('workflow nope is not registered');
  });

  it('pins a REMOTE registration too — the dispatched task carries the pinned version', async () => {
    const store = new InMemoryStateStore();
    const transport = new InMemoryTransport();
    const engine = new WorkflowEngine({ store, transport });
    const seen: Array<{ version: string; group: string }> = [];
    const executor = {
      async advance(run: WorkflowRun): Promise<WorkflowDecision> {
        seen.push({ version: run.workflowVersion, group: 'py' });
        return {
          taskId: 't',
          runId: run.id,
          status: 'completed' as const,
          commands: [],
          output: { servedVersion: run.workflowVersion },
        };
      },
    };
    engine.registerRemote('py', '1', { group: 'py', executor });
    engine.registerRemote('py', '2', { group: 'py', executor });

    await engine.start('py', {}, 'py1', { version: '1' });
    const run = await settle(store, 'py1');

    // A registerRemote registration lives in the same name@version registry, so it pins like any
    // other — and the version travels to the worker, which replays THAT body.
    expect(run.workflowVersion).toBe('1');
    expect(run.output).toEqual({ servedVersion: '1' });
    expect(seen).toEqual([{ version: '1', group: 'py' }]);
  });

  it('refuses a pinned start that would resolve by CONVENTION (an invented version, not a verified one)', async () => {
    const store = new InMemoryStateStore();
    const transport = new LiveGroupTransport();
    const engine = new WorkflowEngine({ store, transport, namespace: 'default' });

    // `legacy` is live as a worker group but registered nowhere: convention routing would stamp the
    // '1' default. Pinning must not be answered with a version nobody checked — even '1' itself.
    await expect(engine.start('legacy', {}, 'conv-pin', { version: '1' })).rejects.toThrow(
      /legacy@1 is not registered/,
    );
    expect(await store.getRun('conv-pin')).toBeNull();
    expect(transport.tasks).toEqual([]);

    // Unpinned, convention routing still works exactly as before — the pin narrows, nothing else.
    await engine.start('legacy', {}, 'conv-open');
    const run = await settle(store, 'conv-open');
    expect(run.status).toBe('completed');
    expect(transport.tasks.map((t) => t.group)).toEqual(['legacy']);

    // The escape hatch: register the version for real, and it pins like any other registration.
    engine.remote('legacy', { group: 'legacy', version: '4' });
    await engine.start('legacy', {}, 'conv-registered', { version: '4' });
    const pinned = await settle(store, 'conv-registered');
    expect(pinned.workflowVersion).toBe('4');
    expect(pinned.output).toEqual({ servedVersion: '4' });
  });

  it("refuses a pinned start that would INHERIT its remote ancestor's registration", async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store, transport: new InMemoryTransport() });
    const advanced: string[] = [];
    const executor = {
      async advance(run: WorkflowRun): Promise<WorkflowDecision> {
        advanced.push(`${run.workflow}@${run.workflowVersion}`);
        return {
          taskId: 't',
          runId: run.id,
          status: 'completed' as const,
          commands: [],
          output: null,
        };
      },
    };
    engine.registerRemote('parent', '7', { group: 'py-workflows', executor });

    // The shape `findRemoteAncestor` walks: a live parent run plus the `child:<id>` waiter the parent
    // writes BEFORE starting the child.
    const now = new Date();
    await store.createRun({
      id: 'par1',
      workflow: 'parent',
      workflowVersion: '7',
      status: 'suspended',
      input: {},
      createdAt: now,
      updatedAt: now,
    });
    await store.putSignalWaiter({ token: 'child:leaf1', runId: 'par1', seq: 0 });

    // Unpinned this inherits and runs (proving the ancestor really is reachable from here)…
    await engine.start('leaf', {}, 'leaf1');
    expect((await settle(store, 'leaf1')).workflowVersion).toBe('7'); // the ancestor's, inherited

    // …but a PIN gets an error, because the inherited version is the ancestor's own, not evidence
    // that the worker has a `leaf` body at the version asked for.
    await store.putSignalWaiter({ token: 'child:leaf2', runId: 'par1', seq: 1 });
    await expect(engine.start('leaf', {}, 'leaf2', { version: '9' })).rejects.toThrow(
      /leaf@9 is not registered/,
    );
    expect(await store.getRun('leaf2')).toBeNull();
    // Only the unpinned child was ever driven (the parent's own resume, woken by that child
    // completing, is filtered out — it says nothing about the pin).
    expect(advanced.filter((a) => a.startsWith('leaf'))).toEqual(['leaf@7']);
  });

  it('pins a child started from a workflow body — the older child body is the one that runs', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '1', async () => 'child-v1');
    engine.register('child', '2', async () => 'child-v2');
    engine.register('parent', '1', async (ctx) => {
      const pinned = await ctx.child<string>('child', {}, { childId: 'c-old', version: '1' });
      const newest = await ctx.child<string>('child', {}, { childId: 'c-new' });
      return { pinned, newest };
    });

    await engine.start('parent', {}, 'p1');
    const run = await settle(store, 'p1');

    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ pinned: 'child-v1', newest: 'child-v2' });
    expect((await store.getRun('c-old'))?.workflowVersion).toBe('1');
    expect((await store.getRun('c-new'))?.workflowVersion).toBe('2');
  });

  it('fails the PARENT when a pinned child names a version that is not registered', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('child', '2', async () => 'child-v2');
    engine.register('parent', '1', async (ctx) =>
      ctx.child<string>('child', {}, { childId: 'c-gone', version: '1' }),
    );

    await engine.start('parent', {}, 'p2');
    const run = await settle(store, 'p2');

    // The failed start is delivered to the parent's child waiter — the parent fails loudly with the
    // cause instead of parking suspended-forever on a child that was never created.
    expect(run.status).toBe('failed');
    expect(run.error?.message).toMatch(/child@1 is not registered/);
    expect(await store.getRun('c-gone')).toBeNull();
  });
});
