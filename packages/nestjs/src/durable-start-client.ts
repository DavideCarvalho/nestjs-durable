import { type StartRunDeps, startRun } from '@dudousxd/durable-worker';
import {
  type RunResult,
  type StartOptions,
  type WorkflowClass,
  type WorkflowInputOf,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import type { DurableWorkerModuleOptions } from './durable-worker.module';

/**
 * The **store-less `engine.start` facade** for a tenant worker. Provided under the `WorkflowEngine`
 * DI token by {@link DurableWorkerModule}, so tenant code calls `engine.start(...)` UNCHANGED — it
 * has no idea it is a tenant. Instead of touching a DB, `start` publishes a `StartRunMessage` on the
 * SHARED `durable-start-run` queue (Option B: tenant rides as message DATA, never as wire
 * segmentation). The operator (control plane, `namespace: undefined`) consumes it, stamps the run's
 * namespace from `tenant`, and routes the run's task to `<workflow>@<tenant>` — the group THIS
 * tenant's worker serves.
 *
 * `cancel`/`deleteRun` need the store/driver a tenant does not have; they throw. No wire message
 * exists for them (the operator owns cancellation/retention).
 */
@Injectable()
export class DurableStartClient {
  private readonly tenant: string;

  constructor(
    private readonly options: DurableWorkerModuleOptions,
    private readonly deps?: StartRunDeps,
  ) {
    this.tenant = options.tenant ?? 'default';
  }

  start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId?: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  start(workflow: string, input: unknown, runId?: string, opts?: StartOptions): Promise<RunResult>;
  async start(
    workflow: string,
    input: unknown,
    runId: string = globalThis.crypto.randomUUID(),
    opts?: StartOptions,
  ): Promise<RunResult> {
    const name = workflowName(workflow);
    await startRun(this.options.connection, {
      tenant: this.tenant,
      workflow: name,
      input,
      runId,
      // Option B: DO NOT pass `namespace` — the start-run queue stays the shared
      // `durable-start-run` the operator consumes; tenant rides only as message data.
      ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
      ...(opts?.tags !== undefined ? { tags: opts.tags } : {}),
      ...(opts?.searchAttributes !== undefined ? { searchAttributes: opts.searchAttributes } : {}),
      ...(this.deps !== undefined ? { deps: this.deps } : {}),
    });
    return { runId, status: 'pending' };
  }

  cancel(_runId: string): Promise<void> {
    return Promise.reject(
      new Error(
        'cancel() is not available on a tenant worker (no store). Cancel from the control plane.',
      ),
    );
  }

  deleteRun(_runId: string): Promise<void> {
    return Promise.reject(
      new Error(
        'deleteRun() is not available on a tenant worker (no store). Delete from the control plane.',
      ),
    );
  }
}
