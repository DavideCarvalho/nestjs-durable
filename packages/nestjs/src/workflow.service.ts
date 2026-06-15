import { randomUUID } from 'node:crypto';
import {
  type RunResult,
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
   */
  waitForRun(runId: string, opts?: { timeoutMs?: number }): Promise<RunResult> {
    return this.engine.waitForRun(runId, opts);
  }

  /** Deliver an external signal (e.g. from a webhook) to the run waiting on `token`. */
  signal(token: string, payload: unknown): Promise<RunResult | null> {
    return this.engine.signal(token, payload);
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
   * starts a fresh run of every workflow subscribed via `@Workflow({ onEvent })` / `@OnEvent` (the
   * payload becomes its input). Pass `opts.id` to dedupe redeliveries. Returns how many runs it
   * touched (resumed + started).
   */
  publishEvent(name: string, payload: unknown, opts?: { id?: string }): Promise<number> {
    return this.engine.publishEvent(name, payload, opts);
  }
}
