import { parseDuration } from './duration';
import { FatalError, WorkflowSuspended } from './errors';
import type {
  EngineEvent,
  EngineListener,
  RemoteStepDef,
  RunResult,
  StateStore,
  StepError,
  StepKind,
  StepOptions,
  Transport,
  WorkflowCtx,
  WorkflowRun,
} from './interfaces';
import { stepId } from './protocol';

type WorkflowFn = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

interface RegisteredWorkflow {
  name: string;
  version: string;
  fn: WorkflowFn;
}

const versionKey = (name: string, version: string): string => `${name}@${version}`;

/** True when version `a` is newer than `b` (numeric when both parse as numbers, else natural sort). */
function isNewerVersion(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na > nb;
  return a.localeCompare(b, undefined, { numeric: true }) > 0;
}

interface PendingRemote {
  resolve: (output: unknown) => void;
  reject: (error: Error) => void;
}

export interface WorkflowEngineDeps {
  store: StateStore;
  transport?: Transport;
  /** Epoch-ms clock; injectable for tests. Defaults to `Date.now`. */
  clock?: () => number;
  /** Unique id for this engine instance, used for recovery leases. Defaults to a random id. */
  instanceId?: string;
  /** Recovery lease duration in ms — how long this instance owns a run it picked up. Default 30s. */
  leaseMs?: number;
}

/**
 * The orchestrator. Owns workflow state and replays runs deterministically: each step's
 * result is checkpointed, so on resume a completed step returns its saved output instead of
 * re-executing. Remote steps are dispatched over the Transport; their results checkpoint the
 * same way local steps do.
 */
export class WorkflowEngine {
  private readonly store: StateStore;
  private readonly transport?: Transport;
  private readonly clock: () => number;
  private readonly instanceId: string;
  private readonly leaseMs: number;
  /** Every registered workflow, keyed by `name@version` — so old versions stay runnable. */
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  /** The newest registered version per workflow name — used to `start` new runs. */
  private readonly latest = new Map<string, RegisteredWorkflow>();
  /** In-flight remote steps awaiting a worker result, keyed by stepId. */
  private readonly pending = new Map<string, PendingRemote>();
  private readonly listeners = new Set<EngineListener>();
  /** Executions currently in flight, so a graceful shutdown can wait for them to settle. */
  private readonly inflight = new Set<Promise<RunResult>>();
  private draining = false;

  constructor(deps: WorkflowEngineDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.clock = deps.clock ?? Date.now;
    this.instanceId = deps.instanceId ?? globalThis.crypto.randomUUID();
    this.leaseMs = deps.leaseMs ?? 30_000;
    this.transport?.onResult(async (result) => {
      const waiter = this.pending.get(result.stepId);
      if (!waiter) return;
      this.pending.delete(result.stepId);
      if (result.status === 'completed') {
        waiter.resolve(result.output);
      } else {
        waiter.reject(new RemoteStepError(result.error));
      }
    });
  }

  /**
   * Register a workflow version. Register multiple versions of the same name to keep in-flight
   * runs working across a breaking change: old runs resume on the version they started on, new
   * runs start on the newest registered version.
   */
  register(name: string, version: string, fn: WorkflowFn): void {
    const registered: RegisteredWorkflow = { name, version, fn };
    this.workflows.set(versionKey(name, version), registered);
    const current = this.latest.get(name);
    if (!current || isNewerVersion(version, current.version)) this.latest.set(name, registered);
  }

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: Omit<EngineEvent, 'at'>): void {
    const full: EngineEvent = { ...event, at: new Date() };
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // a misbehaving subscriber must never break workflow execution
      }
    }
  }

  async start(workflow: string, input: unknown, runId: string): Promise<RunResult> {
    const registered = this.latest.get(workflow);
    if (!registered) throw new Error(`workflow ${workflow} is not registered`);
    const now = new Date();
    const run: WorkflowRun = {
      id: runId,
      workflow,
      workflowVersion: registered.version,
      status: 'running',
      input,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);
    this.emit({ type: 'run.started', runId, workflow });
    return this.track(this.execute(run, registered.fn));
  }

  async resume(runId: string): Promise<RunResult> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    // Pin to the version the run STARTED on — replay is positional, so running a changed
    // workflow body against old checkpoints would corrupt the run.
    const registered = this.workflows.get(versionKey(run.workflow, run.workflowVersion));
    if (!registered) {
      throw new Error(
        `workflow ${run.workflow}@${run.workflowVersion} is not registered — keep the prior version deployed so in-flight runs can drain (skew protection)`,
      );
    }
    return this.track(this.execute(run, registered.fn));
  }

  /** Track an in-flight execution so {@link drain} can wait for it. */
  private track(p: Promise<RunResult>): Promise<RunResult> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  /**
   * Graceful shutdown: stop picking up new runs (recovery/timer become no-ops) and wait for
   * in-flight executions to settle, up to `timeoutMs`. Call from your app's shutdown hook so a
   * deploy hands off cleanly instead of leaving runs to the lease timeout.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    this.draining = true;
    if (this.inflight.size === 0) return;
    const timer = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      (t as { unref?: () => void }).unref?.();
    });
    await Promise.race([Promise.allSettled([...this.inflight]), timer]);
  }

  /**
   * Resume every run left incomplete by a crash or deploy. Called on boot. Completed steps
   * replay from their checkpoints, so only the work that had not finished runs again.
   */
  async recoverIncomplete(): Promise<RunResult[]> {
    return this.resumeLeased(await this.store.listIncompleteRuns());
  }

  /**
   * Resume every suspended run whose durable timer is due. Call periodically (a poller) and on
   * boot. A run still not due re-suspends cheaply without running new work.
   */
  async resumeDueTimers(nowMs: number = this.clock()): Promise<RunResult[]> {
    return this.resumeLeased(await this.store.listDueTimers(nowMs), nowMs);
  }

  /**
   * Resume each run only if this instance can acquire its recovery lease — so when several
   * replicas recover or poll at once, each run is picked up by exactly one of them.
   */
  private async resumeLeased(
    runs: WorkflowRun[],
    nowMs: number = this.clock(),
  ): Promise<RunResult[]> {
    if (this.draining) return []; // shutting down — don't pick up new runs
    const results: RunResult[] = [];
    for (const run of runs) {
      const acquired = await this.store.tryLockRun(
        run.id,
        this.instanceId,
        nowMs + this.leaseMs,
        nowMs,
      );
      if (acquired) results.push(await this.resume(run.id));
    }
    return results;
  }

  /**
   * Deliver an external signal to the run waiting on `token` and resume it with `payload`.
   * Returns the run result, or null if no run is waiting for that token.
   */
  async signal(token: string, payload: unknown): Promise<RunResult | null> {
    const waiter = await this.store.takeSignalWaiter(token);
    if (!waiter) return null;
    const at = new Date();
    await this.store.saveCheckpoint({
      runId: waiter.runId,
      seq: waiter.seq,
      name: `signal:${token}`,
      kind: 'signal',
      stepId: stepId(waiter.runId, waiter.seq),
      status: 'completed',
      output: payload,
      attempts: 1,
      startedAt: at,
      finishedAt: at,
    });
    return this.resume(waiter.runId);
  }

  /** Cancel a run (e.g. from the dashboard). Returns null if the run does not exist. */
  async cancel(runId: string): Promise<RunResult | null> {
    const run = await this.store.getRun(runId);
    if (!run) return null;
    const error = { message: 'cancelled' };
    await this.store.updateRun(runId, { status: 'cancelled', error, updatedAt: new Date() });
    this.emit({ type: 'run.failed', runId, workflow: run.workflow, error });
    return { runId, status: 'cancelled', error };
  }

  /** Checkpoint a finished step and announce it — the two things that must always happen together. */
  private async completeStep(step: {
    runId: string;
    seq: number;
    name: string;
    kind: StepKind;
    output: unknown;
    attempts: number;
    startedAt: Date;
    workerGroup?: string;
  }): Promise<void> {
    await this.store.saveCheckpoint({
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      stepId: stepId(step.runId, step.seq),
      status: 'completed',
      output: step.output,
      attempts: step.attempts,
      workerGroup: step.workerGroup,
      startedAt: step.startedAt,
      finishedAt: new Date(),
    });
    this.emit({
      type: 'step.completed',
      runId: step.runId,
      seq: step.seq,
      name: step.name,
      kind: step.kind,
      output: step.output,
      durationMs: Date.now() - step.startedAt.getTime(),
    });
  }

  private async execute(run: WorkflowRun, fn: WorkflowFn): Promise<RunResult> {
    const ctx = this.makeCtx(run.id);
    try {
      const output = await fn(ctx, run.input);
      await this.store.updateRun(run.id, { status: 'completed', output, updatedAt: new Date() });
      this.emit({ type: 'run.completed', runId: run.id, workflow: run.workflow, output });
      return { runId: run.id, status: 'completed', output };
    } catch (err) {
      if (err instanceof WorkflowSuspended) {
        await this.store.updateRun(run.id, {
          status: 'suspended',
          wakeAt: err.wakeAt,
          updatedAt: new Date(),
        });
        this.emit({ type: 'run.suspended', runId: run.id, workflow: run.workflow });
        return { runId: run.id, status: 'suspended' };
      }
      const error = {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      };
      await this.store.updateRun(run.id, { status: 'failed', error, updatedAt: new Date() });
      this.emit({ type: 'run.failed', runId: run.id, workflow: run.workflow, error });
      return { runId: run.id, status: 'failed', error };
    } finally {
      // Release the recovery lease once the run reaches a terminal/suspended state, so the
      // next instance (or the timer poller) can pick it up promptly.
      await this.store.releaseRunLock(run.id);
    }
  }

  private makeCtx(runId: string): WorkflowCtx {
    let seq = -1;
    const nextSeq = () => {
      seq += 1;
      return seq;
    };
    const store = this.store;
    return {
      runId,
      step: async <T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T> => {
        const current = nextSeq();
        const existing = await store.getCheckpoint(runId, current);
        if (existing && existing.status === 'completed') {
          return existing.output as T;
        }
        const maxAttempts = Math.max(1, options?.retries ?? 1);
        const startedAt = new Date();
        for (let attempt = 1; ; attempt += 1) {
          try {
            const output = await fn();
            await this.completeStep({
              runId,
              seq: current,
              name,
              kind: 'local',
              output,
              attempts: attempt,
              startedAt,
            });
            return output;
          } catch (err) {
            if (err instanceof FatalError || attempt >= maxAttempts) throw err;
          }
        }
      },
      call: <TInput, TOutput>(step: RemoteStepDef<TInput, TOutput>, input: TInput) =>
        this.callRemote(runId, nextSeq(), step, input),
      sleep: async (duration: string | number): Promise<void> => {
        const current = nextSeq();
        const now = this.clock();
        const existing = await store.getCheckpoint(runId, current);
        if (existing) {
          // Timer already recorded: resume if due, otherwise re-suspend cheaply.
          if (now >= (existing.wakeAt ?? 0)) return;
          throw new WorkflowSuspended(existing.wakeAt ?? now);
        }
        const wakeAt = now + parseDuration(duration);
        const at = new Date();
        await store.saveCheckpoint({
          runId,
          seq: current,
          name: 'sleep',
          kind: 'sleep',
          stepId: stepId(runId, current),
          status: 'completed',
          wakeAt,
          attempts: 1,
          startedAt: at,
          finishedAt: at,
        });
        throw new WorkflowSuspended(wakeAt);
      },
      waitForSignal: async <T>(token: string): Promise<T> => {
        const current = nextSeq();
        const existing = await store.getCheckpoint(runId, current);
        if (existing && existing.status === 'completed') {
          return existing.output as T;
        }
        await store.putSignalWaiter({ token, runId, seq: current });
        throw new WorkflowSuspended();
      },
    };
  }

  private async callRemote<TInput, TOutput>(
    runId: string,
    seq: number,
    step: RemoteStepDef<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput> {
    const existing = await this.store.getCheckpoint(runId, seq);
    if (existing && existing.status === 'completed') {
      return existing.output as TOutput;
    }
    if (!this.transport) throw new Error('remote steps require a Transport');

    const validInput = step.input.parse(input);
    const id = stepId(runId, seq);
    const startedAt = new Date();

    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.transport.dispatch({
      runId,
      seq,
      name: step.name,
      stepId: id,
      group: step.group,
      input: validInput,
      attempt: 1,
    });
    const rawOutput = await resultPromise;
    const output = step.output.parse(rawOutput) as TOutput;
    await this.completeStep({
      runId,
      seq,
      name: step.name,
      kind: 'remote',
      output,
      attempts: 1,
      workerGroup: step.group,
      startedAt,
    });
    return output;
  }
}

/** Raised inside the workflow when a remote worker reports a step failure. */
export class RemoteStepError extends Error {
  readonly stepError?: StepError;
  constructor(stepError?: StepError) {
    super(stepError?.message ?? 'remote step failed');
    this.name = 'RemoteStepError';
    this.stepError = stepError;
  }
}
