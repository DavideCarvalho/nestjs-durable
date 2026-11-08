import { randomUUID } from 'node:crypto';
import {
  type RepublishLifecycleResult,
  type RepublishLifecycleTarget,
  type RunResult,
  type SignalOptions,
  type StartOptions,
  type WorkflowClass,
  WorkflowEngine,
  type WorkflowInputOf,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';

/** Public entry point for starting and resuming workflow runs. */
@Injectable()
export class WorkflowService {
  constructor(private readonly engine: WorkflowEngine) {}

  /**
   * Enqueue a workflow run — it creates the run (`pending`) and returns `{ runId, status: 'pending' }`
   * immediately; a worker executes the body (so the caller never blocks on workflow logic). Use
   * {@link waitForRun} when you need the outcome. Pass the workflow's **class**
   * (`start(CheckoutWorkflow, input)`) for a typed input + refactor-safety, or a **name** string for a
   * cross-runtime workflow. `runId` defaults to a random id; pass your own to make the start idempotent
   * (a redelivery returns the existing run). `opts.tags` are merged with the workflow's static
   * `@Workflow({ tags })`; `opts.searchAttributes` stamp typed, queryable run data.
   */
  start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId?: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  start(workflow: string, input: unknown, runId?: string, opts?: StartOptions): Promise<RunResult>;
  start(
    workflow: string,
    input: unknown,
    runId: string = randomUUID(),
    opts?: StartOptions,
  ): Promise<RunResult> {
    return this.engine.start(workflow, input, runId, opts);
  }

  resume(runId: string): Promise<RunResult> {
    return this.engine.resume(runId);
  }

  /**
   * Resolve once a run settles — terminal (completed/failed/cancelled/dead) or suspended. `start`
   * only enqueues (a worker runs the body), so pair them when a request needs the outcome:
   * `const { runId } = await svc.start(...); const result = await svc.waitForRun(runId)`.
   * `until: 'terminal'` waits past suspensions until the run completes/fails/is cancelled — what a
   * delayed start (`opts.startAt`) needs, since it is `suspended` until its timer fires.
   */
  waitForRun(
    runId: string,
    opts?: { timeoutMs?: number; until?: 'settled' | 'terminal' },
  ): Promise<RunResult> {
    return this.engine.waitForRun(runId, opts);
  }

  /**
   * Deliver an external signal (e.g. from a webhook) to the run waiting on `token`, or buffer it for
   * the next wait on it. With `{ id }`, a re-send with the same token and id is dropped (resolves
   * `null`): see {@link SignalOptions}.
   */
  signal(token: string, payload: unknown, opts?: SignalOptions): Promise<RunResult | null> {
    return this.engine.signal(token, payload, opts);
  }

  /**
   * Ensure a run exists for `runId`, then deliver a signal to it — race-free (the signal is buffered
   * until the run reaches its `waitForSignal`). The durable-entity / accumulator pattern: one
   * long-lived run per key fed events by many calls. See {@link WorkflowEngine.signalWithStart}.
   */
  signalWithStart<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: StartOptions,
  ): Promise<{ runId: string }>;
  signalWithStart(
    workflow: string,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: StartOptions,
  ): Promise<{ runId: string }>;
  signalWithStart(
    workflow: string,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: StartOptions,
  ): Promise<{ runId: string }> {
    return this.engine.signalWithStart(workflow, input, runId, signal, opts);
  }

  /**
   * Publish a named event. Resumes runs waiting on it via `ctx.waitForEvent(name, { match })` and
   * starts a fresh run of every workflow subscribed via `@Workflow({ onEvent })` / `@OnDurableEvent` (the
   * payload becomes its input). Pass `opts.id` to dedupe redeliveries. Returns how many runs it
   * touched (resumed + started).
   *
   * Reliable by default: a publish that touches NOBODY (no live waiter, no subscriber) buffers ONE
   * copy so a LATER `waitForEvent(name, { match })` still consumes it instead of it being dropped —
   * see {@link WorkflowEngine.publishEvent}'s full semantics doc. Pass `opts.buffer: false` to opt out.
   */
  publishEvent(
    name: string,
    payload: unknown,
    opts?: { id?: string; buffer?: boolean },
  ): Promise<number> {
    return this.engine.publishEvent(name, payload, opts);
  }

  /**
   * The runs started by `runId` settling, through `@OnWorkflowCompleted` / `@OnWorkflowFailed` (or
   * an `onEvent` on `runCompletedEvent(...)`). Only subscribers registered on this engine are
   * considered. For the reverse link, `lifecycleSourceOf(run)` reads it from the run itself.
   */
  triggeredRuns(runId: string): Promise<string[]> {
    return this.engine.triggeredRuns(runId);
  }

  /**
   * Publish settled runs' lifecycle events again: to a subscriber registered after they settled, or
   * one restricted by `subscriber`. Subscribers already started for a run are not started again.
   * See `WorkflowEngine.republishLifecycle`.
   */
  republishLifecycle(target: RepublishLifecycleTarget): Promise<RepublishLifecycleResult> {
    return this.engine.republishLifecycle(target);
  }
}
