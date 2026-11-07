import 'reflect-metadata';
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { RemoteTask } from '@dudousxd/nestjs-durable-core';
import {
  EventEmitterTransport,
  RESULT_EVENT,
  TASK_EVENT,
} from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  ManualWorkflowClock,
  Workflow,
  WorkflowClient,
  type WorkflowContext,
  WorkflowWorker,
  WorkflowsModule,
} from '@nestjs/workflows';
import { EventEmitter2 } from 'eventemitter2';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableRemoteStepsModule, remoteStep } from './index';

/**
 * Cross-language: a `@nestjs/workflows` workflow runs a step on the PYTHON durable worker
 * (`clients/python`, `Worker.process_task`). The task and the result cross a process boundary as
 * durable's JSON wire format; a line-per-message stdio bridge stands in for the broker (BullMQ/SQS
 * runners call the same `process_task`). Skipped when `python3` is not on the PATH.
 */
const pythonRoot = fileURLToPath(new URL('../../../clients/python', import.meta.url));
const script = fileURLToPath(new URL('./__fixtures__/python_step_worker.py', import.meta.url));

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

@Workflow('score')
@Injectable()
class ScoreWorkflow {
  async run(ctx: WorkflowContext, input: { handler: string; text: string }) {
    try {
      return await remoteStep(ctx, input.handler, {
        group: 'scoring',
        input: { text: input.text },
        timeout: '1m',
        retry: false,
      });
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
}

let python: ChildProcessWithoutNullStreams | undefined;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  python?.kill();
  python = undefined;
});

async function boot() {
  const emitter = new EventEmitter2();
  python = spawn('python3', ['-I', script, pythonRoot]);
  const child = python;
  emitter.on(TASK_EVENT, (task: RemoteTask) => child.stdin.write(`${JSON.stringify(task)}\n`));
  createInterface({ input: child.stdout }).on('line', (line) =>
    emitter.emit(RESULT_EVENT, JSON.parse(line)),
  );
  const clock = new ManualWorkflowClock(Date.parse('2026-11-01T00:00:00Z'));
  @Module({
    imports: [
      WorkflowsModule.forRoot({ clock, worker: false }),
      DurableRemoteStepsModule.forRoot({ transport: new EventEmitterTransport(emitter) }),
    ],
    providers: [ScoreWorkflow],
  })
  class HostModule {}
  const app = await NestFactory.createApplicationContext(HostModule, { logger: false });
  close = () => app.close();
  const client = app.get(WorkflowClient);
  const worker = app.get(WorkflowWorker);
  const until = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      await worker.drain();
      const status = (await client.getStatus(id))?.status;
      if (status === 'completed' || status === 'failed') return client.getStatus(id);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`instance ${id} did not finish`);
  };
  return { client, until };
}

describe.skipIf(!hasPython())('remoteStep → the Python durable worker', () => {
  it('runs the step in Python and returns its output to the official workflow', async () => {
    const { client, until } = await boot();
    await client.start(ScoreWorkflow, { handler: 'py.score', text: 'hello' }, { id: 'py-1' });
    const instance = await until('py-1');
    expect(instance?.output).toEqual({ score: 50, lang: 'python' });
  });

  it('a Python exception fails the step with its message', async () => {
    const { client, until } = await boot();
    await client.start(ScoreWorkflow, { handler: 'py.reject', text: 'x' }, { id: 'py-2' });
    const instance = await until('py-2');
    expect((instance?.output as { error: string }).error).toContain("cannot score 'x'");
  });
});
