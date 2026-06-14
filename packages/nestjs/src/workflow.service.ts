import { randomUUID } from 'node:crypto';
import {
  type RunResult,
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
   */
  start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId?: string,
  ): Promise<RunResult>;
  start(workflow: string, input: unknown, runId?: string): Promise<RunResult>;
  start(workflow: string, input: unknown, runId: string = randomUUID()): Promise<RunResult> {
    return this.engine.start(workflow, input, runId);
  }

  resume(runId: string): Promise<RunResult> {
    return this.engine.resume(runId);
  }

  /** Deliver an external signal (e.g. from a webhook) to the run waiting on `token`. */
  signal(token: string, payload: unknown): Promise<RunResult | null> {
    return this.engine.signal(token, payload);
  }
}
