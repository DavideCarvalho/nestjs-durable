import 'reflect-metadata';
import {
  DurableWorkflow,
  InMemoryStateStore,
  InMemoryTransport,
  type WorkflowCtx,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';

@Injectable()
class GreeterService {
  greeting(name: string): string {
    return `hi ${name}`;
  }
}

@Workflow({ name: 'statics-inner', version: '1' })
class InnerWorkflow extends DurableWorkflow {
  constructor(private readonly greeter: GreeterService) {
    super();
  }

  async run(_ctx: WorkflowCtx, input: { name: string }) {
    return { greeting: this.greeter.greeting(input.name) };
  }
}

@Workflow({ name: 'statics-side', version: '1' })
class SideWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: { tag: string }) {
    return `side:${input.tag}`;
  }
}

// The outer body starts both ONLY via the class-first statics — no ctx threading, no injection.
@Workflow({ name: 'statics-outer', version: '1' })
class OuterWorkflow extends DurableWorkflow {
  async run(_ctx: WorkflowCtx, input: { name: string }) {
    const inner = await InnerWorkflow.execute({ name: input.name });
    const side = await SideWorkflow.start({ tag: input.name });
    return { greeting: inner.greeting, sideRunId: side.runId };
  }
}

async function bootModule() {
  const store = new InMemoryStateStore();
  const mod = await Test.createTestingModule({
    imports: [DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 })],
    providers: [GreeterService, InnerWorkflow, SideWorkflow, OuterWorkflow],
  }).compile();
  await mod.init();
  return { mod, store };
}

async function poll(fn: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('poll timed out');
}

describe('class-first statics through the NestJS module (registrar binding)', () => {
  it('OUTSIDE a workflow: start enqueues (engine.start semantics), execute awaits the typed output', async () => {
    const { mod, store } = await bootModule();
    try {
      const started = await InnerWorkflow.start({ name: 'davi' });
      expect(started.status).toBe('pending');
      await poll(async () => (await store.getRun(started.runId))?.status === 'completed');

      const out = await InnerWorkflow.execute({ name: 'davi' }, { timeoutMs: 2000 });
      expect(out.greeting).toBe('hi davi');
    } finally {
      await mod.close();
    }
  });

  it('INSIDE a workflow: execute = awaited child, start = fire-and-forget child — DI constructors intact', async () => {
    const { mod, store } = await bootModule();
    try {
      const out = await OuterWorkflow.execute({ name: 'davi' }, { timeoutMs: 3000 });
      expect(out.greeting).toBe('hi davi');
      // The fire-and-forget side workflow is a real linked run that completes on its own.
      await poll(async () => (await store.getRun(out.sideRunId))?.status === 'completed');
      expect((await store.getRun(out.sideRunId))?.output).toBe('side:davi');
    } finally {
      await mod.close();
    }
  });
});
