import { DurableModule, Step, Workflow, WorkflowService } from '@dudousxd/nestjs-durable';
import {
  InMemoryStateStore,
  type WorkflowCtx,
  clearDurableExecutionWrappers,
} from '@dudousxd/nestjs-durable-core';
import {
  durableTelescopeExtension,
  durableTraceContext,
  runTraceId,
} from '@dudousxd/nestjs-durable-telescope';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import {
  InMemoryStorageProvider,
  TELESCOPE_STORAGE,
  TelescopeModule,
  TelescopeService,
} from '@dudousxd/nestjs-telescope';
import { Injectable, Module } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';

/**
 * End-to-end: the REAL module graph — `DurableModule` + `TelescopeModule` in one Nest app, the
 * event-emitter transport actually dispatching `@Step` handlers — asserting that what a workflow
 * turn and a step handler DO is correlated to the unit of work that did it.
 *
 * A test that called the wrapper directly would prove nothing here: the whole risk in this change is
 * whether the seam we hooked (`useDurableExecution`, folded in by the engine's `runExecution` and by
 * core's `runStepHandler`) is the one the engine really drives at runtime. So every assertion below
 * reads entries recorded by ordinary application code — `telescope.record(...)` from inside a
 * workflow body and from inside a step handler, standing in for the query/cache/exception watchers a
 * real app runs — after a real run has settled.
 */

/** The `where` marker each recorded entry carries, so a test can find its own entries. */
function markerOf(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null || !('where' in content)) return undefined;
  const where = Reflect.get(content, 'where');
  return typeof where === 'string' ? where : undefined;
}

/** The `event` field of a `durable` entry's content (`run.started`, `step.failed`, …). */
function eventOf(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null || !('event' in content)) return undefined;
  const event = Reflect.get(content, 'event');
  return typeof event === 'string' ? event : undefined;
}

@Injectable()
class TracedSteps {
  constructor(private readonly telescope: TelescopeService) {}

  @Step()
  async succeed(_input: { id: string }): Promise<{ ok: true }> {
    this.telescope.record({ type: 'query', content: { where: 'step:succeed' } });
    return { ok: true };
  }

  @Step()
  async explode(_input: { id: string }): Promise<never> {
    // Recorded immediately before throwing: if the scope were opened around the lifecycle EVENT
    // rather than around execution, this entry would land outside every batch and every trace.
    this.telescope.record({ type: 'query', content: { where: 'step:explode' } });
    throw new Error('step exploded');
  }
}

@Workflow({ name: 'traced-child', version: '1' })
class TracedChildWorkflow {
  constructor(private readonly telescope: TelescopeService) {}

  async run(_ctx: WorkflowCtx, _input: unknown): Promise<string> {
    this.telescope.record({ type: 'query', content: { where: 'child:body' } });
    return 'child-done';
  }
}

@Workflow({ name: 'traced', version: '1' })
class TracedWorkflow {
  constructor(
    private readonly steps: TracedSteps,
    private readonly telescope: TelescopeService,
  ) {}

  async run(ctx: WorkflowCtx, input: { fail: boolean; child: boolean }): Promise<string> {
    this.telescope.record({ type: 'query', content: { where: 'workflow:body' } });
    await ctx.step(this.steps.succeed, { id: 'a' });
    if (input.child) await ctx.child('traced-child', {});
    if (input.fail) await ctx.step(this.steps.explode, { id: 'b' });
    return 'done';
  }
}

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    TelescopeModule.forRoot({
      storage: new InMemoryStorageProvider(),
      extensions: [durableTelescopeExtension()],
      // The no-OTel-SDK path, which is what most apps are: `@opentelemetry/api` alone propagates
      // nothing, so without this the batches would still correlate but the trace ids would all be
      // null. See `durableTraceContext`.
      traceContext: durableTraceContext(),
      recorder: { flushIntervalMs: 5 },
    }),
    DurableModule.forRootAsync({
      inject: [EventEmitter2],
      useFactory: (emitter: EventEmitter2) => ({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(emitter),
        timerPollMs: 50,
      }),
    }),
  ],
  providers: [TracedWorkflow, TracedChildWorkflow, TracedSteps],
})
class TracedAppModule {}

interface StoredEntry {
  type: string;
  content: unknown;
  batchId: string;
  traceId: string | null;
  origin: string;
}

async function bootAndRun(input: { fail: boolean; child: boolean }, runId: string) {
  const moduleRef = await Test.createTestingModule({ imports: [TracedAppModule] }).compile();
  await moduleRef.init();
  const workflows = moduleRef.get(WorkflowService);
  const telescope = moduleRef.get(TelescopeService);

  await workflows.start('traced', input, runId);
  // A dispatched `ctx.step` suspends the turn and resumes when the result lands, so the run settles
  // over several turns. Poll until it is terminal rather than guessing a number of ticks.
  let status = 'pending';
  for (let i = 0; i < 500 && (status === 'pending' || status === 'suspended'); i += 1) {
    const run = await workflows.waitForRun(runId);
    status = run.status;
    if (status === 'pending' || status === 'suspended') {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  await telescope.flush();
  const storage = moduleRef.get<InMemoryStorageProvider>(TELESCOPE_STORAGE);
  const page = await storage.get({ limit: 1000 });
  const entries: StoredEntry[] = page.data;
  return { entries, status, moduleRef };
}

describe('durable work is traced end-to-end in a real app', () => {
  // Each test boots its own app, and each app's watcher adds a wrapper to the engine's
  // process-level registry. A real process registers one and keeps it for its lifetime; a test file
  // that boots three would otherwise leave the previous app's wrapper — pointing at a closed
  // Telescope — running around the next app's workflows.
  afterEach(() => clearDurableExecutionWrappers());

  it('puts a failing step, its turn and the run lifecycle in ONE trace', async () => {
    const { entries, status, moduleRef } = await bootAndRun(
      { fail: true, child: false },
      'trace-fail',
    );
    expect(status).toBe('failed');

    const expected = runTraceId('trace-fail');

    // The entry the failing step handler recorded immediately before throwing.
    const stepEntry = entries.find((e) => markerOf(e.content) === 'step:explode');
    expect(stepEntry, 'the failing step handler recorded no entry').toBeDefined();
    expect(stepEntry?.traceId).toBe(expected);

    // The entry the workflow body recorded, on whichever turn.
    const bodyEntry = entries.find((e) => markerOf(e.content) === 'workflow:body');
    expect(bodyEntry, 'the workflow body recorded no entry').toBeDefined();
    expect(bodyEntry?.traceId).toBe(expected);

    // A batch was open while the handler ran, and it is the batch of the turn that dispatched it —
    // not a synthetic per-entry one, which is what a batchless record gets.
    expect(stepEntry?.origin).toBe('queue');
    expect(stepEntry?.batchId).toBe(bodyEntry?.batchId);

    // And the durable lifecycle entries the watcher records from engine events.
    const durable = entries.filter((e) => e.type === 'durable');
    expect(durable.map((e) => eventOf(e.content))).toContain('step.failed');
    expect([...new Set(durable.map((e) => e.traceId))]).toEqual([expected]);

    // The whole point: one trace, not three.
    const traceIds = new Set(
      [stepEntry, bodyEntry, ...durable].map((e) => e?.traceId).filter((id) => id != null),
    );
    expect([...traceIds]).toEqual([expected]);

    await moduleRef.close();
  });

  it('traces a step that succeeds, not just the failing path', async () => {
    const { entries, status, moduleRef } = await bootAndRun(
      { fail: false, child: false },
      'trace-ok',
    );
    expect(status).toBe('completed');

    const stepEntry = entries.find((e) => markerOf(e.content) === 'step:succeed');
    expect(stepEntry, 'the succeeding step handler recorded no entry').toBeDefined();
    expect(stepEntry?.traceId).toBe(runTraceId('trace-ok'));
    // A batch was actually opened around it — a traceless, batchless entry would fail here even if
    // the trace id happened to line up.
    expect(stepEntry?.batchId).toBeTruthy();
    expect(stepEntry?.origin).toBe('queue');

    await moduleRef.close();
  });

  it('gives a step the batch of the turn that dispatched it, and a child run its own', async () => {
    const { entries, status, moduleRef } = await bootAndRun(
      { fail: false, child: true },
      'trace-child',
    );
    expect(status).toBe('completed');

    const stepEntry = entries.find((e) => markerOf(e.content) === 'step:succeed');
    const bodyEntries = entries.filter((e) => markerOf(e.content) === 'workflow:body');
    const childEntry = entries.find((e) => markerOf(e.content) === 'child:body');
    expect(stepEntry).toBeDefined();
    expect(childEntry, 'the child workflow body recorded no entry').toBeDefined();
    expect(bodyEntries.length).toBeGreaterThan(0);

    // NESTING, half 1 — the in-process transport runs the step handler inside the turn that
    // dispatched it, and the wrapper REUSES that turn's batch rather than nesting a second one. So
    // the step's entry shares a batch with one of the turns' entries, not a batch of its own.
    const turnBatches = new Set(bodyEntries.map((e) => e.batchId));
    expect(turnBatches.has(stepEntry?.batchId ?? '')).toBe(true);

    // NESTING, half 2 — a child workflow is a different run, so it gets its OWN batch and its own
    // trace (anchored on the child's run id), rather than being folded into the parent's.
    expect(turnBatches.has(childEntry?.batchId ?? '')).toBe(false);
    expect(childEntry?.traceId).not.toBe(runTraceId('trace-child'));
    expect(childEntry?.traceId).toBeTruthy();

    await moduleRef.close();
  });
});
