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
   * Start a workflow run. Pass the workflow's **class** (`start(CheckoutWorkflow, input)`) for a typed
   * input + refactor-safety, or a **name** string for a cross-runtime workflow. `runId` defaults to a
   * random id; pass your own to make the start idempotent (a redelivery returns the existing run).
   * `opts.tags` are merged with the workflow's static `@Workflow({ tags })` onto the run.
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

  /** Deliver an external signal (e.g. from a webhook) to the run waiting on `token`. */
  signal(token: string, payload: unknown): Promise<RunResult | null> {
    return this.engine.signal(token, payload);
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
