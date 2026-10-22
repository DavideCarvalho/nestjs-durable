import {
  InMemoryStateStore,
  RUN_HISTORY_FIXTURE_VERSION,
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';

export interface RunHistory {
  run: WorkflowRun;
  checkpoints: StepCheckpoint[];
}

/** Format marker of a fixture written by {@link serializeRunHistory} (and `durable export`). Defined
 *  in core so the CLI writes the same value; re-exported here for fixture authors. */
export { RUN_HISTORY_FIXTURE_VERSION };

/**
 * Capture a run's replayable history (the run row + its full checkpoint timeline) from anything with
 * the read API: a `WorkflowEngine`, or a bare `StateStore` (the CLI's `durable export` uses the
 * store). The fixture half of the {@link assertReplayable} loop: capture a representative run,
 * commit it with {@link serializeRunHistory}, and assert it in CI via {@link parseRunHistory}.
 * Returns `null` for an unknown run.
 */
export async function captureHistory(
  source: {
    getRun(runId: string): Promise<WorkflowRun | null | undefined>;
    listCheckpoints(runId: string): Promise<StepCheckpoint[]>;
  },
  runId: string,
): Promise<RunHistory | null> {
  const run = await source.getRun(runId);
  if (!run) return null;
  return { run, checkpoints: await source.listCheckpoints(runId) };
}

/**
 * Serialize a captured history as a pretty-printed JSON fixture (with a trailing newline, so it
 * commits cleanly). Read it back with {@link parseRunHistory}.
 */
export function serializeRunHistory(history: RunHistory): string {
  return `${JSON.stringify({ version: RUN_HISTORY_FIXTURE_VERSION, ...history }, null, 2)}\n`;
}

/**
 * Parse a committed fixture (what {@link serializeRunHistory} / `durable export` writes) back into a
 * {@link RunHistory}, reviving the `Date` fields JSON flattened to ISO strings, so
 * `assertReplayable(register, parseRunHistory(readFileSync('fixture.json', 'utf8')))` just works.
 *
 * Throws on a fixture whose `version` is not {@link RUN_HISTORY_FIXTURE_VERSION}: a fixture written
 * in another format would otherwise replay against the wrong shape. A fixture with NO `version` (a
 * hand-built `{ run, checkpoints }`, the shape these docs showed before the marker existed) is read
 * as version 1.
 */
export function parseRunHistory(json: string): RunHistory {
  const raw = JSON.parse(json) as {
    version?: unknown;
    run?: WorkflowRun;
    checkpoints?: StepCheckpoint[];
  };
  if (!raw || typeof raw !== 'object' || !raw.run || !Array.isArray(raw.checkpoints)) {
    throw new Error('not a run history fixture: expected { run, checkpoints }');
  }
  if (raw.version !== undefined && raw.version !== RUN_HISTORY_FIXTURE_VERSION) {
    throw new Error(
      `unsupported run history fixture version ${JSON.stringify(raw.version)} (this kit reads version ${RUN_HISTORY_FIXTURE_VERSION}); re-export the fixture or upgrade @dudousxd/nestjs-durable-testing`,
    );
  }
  const date = (v: unknown): Date => new Date(v as string | number | Date);
  const run: WorkflowRun = {
    ...raw.run,
    createdAt: date(raw.run.createdAt),
    updatedAt: date(raw.run.updatedAt),
  };
  const checkpoints = raw.checkpoints.map((cp) => ({
    ...cp,
    enqueuedAt: date(cp.enqueuedAt),
    startedAt: date(cp.startedAt),
    finishedAt: date(cp.finishedAt),
  }));
  return { run, checkpoints };
}

/**
 * Replay a recorded run's history against the CURRENT workflow code and throw if they diverged.
 *
 * Capture a real (ideally in-flight or representative) run from production —
 * `{ run: await store.getRun(id), checkpoints: await store.listCheckpoints(id) }` — commit it as a
 * fixture, and assert here in CI. If a code change renamed/reordered/removed a step at a position the
 * history already recorded, the engine raises a `NonDeterminismError` on replay and this rethrows it,
 * catching the break *before* it reaches an in-flight run on deploy (the moment you'd otherwise
 * silently replay the wrong checkpoint into the wrong step). Register the workflow exactly as the app
 * does:
 *
 * ```ts
 * await assertReplayable((engine) => engine.register('pipeline', '1', pipeline.run), fixture);
 * ```
 */
export async function assertReplayable(
  register: (engine: WorkflowEngine) => void,
  history: RunHistory,
): Promise<void> {
  const store = new InMemoryStateStore();
  // Seed as a suspended run with no lock so resume() replays the body against the recorded
  // checkpoints — no transport is wired, so nothing new is dispatched.
  await store.createRun({
    ...history.run,
    status: 'suspended',
    lockedBy: undefined,
    lockedUntil: undefined,
  });
  for (const cp of history.checkpoints) await store.saveCheckpoint(cp);

  const engine = new WorkflowEngine({ store });
  register(engine);
  const result = await engine.resume(history.run.id);
  if (result.status === 'failed' && result.error?.message?.startsWith('non-determinism')) {
    const err = new Error(result.error.message);
    err.name = 'NonDeterminismError';
    throw err;
  }
}
