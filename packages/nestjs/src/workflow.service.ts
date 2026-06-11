import { randomUUID } from 'node:crypto';
import { type RunResult, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';

/** Public entry point for starting and resuming workflow runs. */
@Injectable()
export class WorkflowService {
  constructor(private readonly engine: WorkflowEngine) {}

  start(workflow: string, input: unknown, runId: string = randomUUID()): Promise<RunResult> {
    return this.engine.start(workflow, input, runId);
  }

  resume(runId: string): Promise<RunResult> {
    return this.engine.resume(runId);
  }
}
