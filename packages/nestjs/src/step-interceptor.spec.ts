import 'reflect-metadata';
import type { StepInvocation } from '@dudousxd/nestjs-durable-core';
import { InMemoryStateStore, InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import type { DurableStepInterceptor } from './step-interceptor';
import { StepInterceptor } from './step-interceptor';
import { WorkflowService } from './workflow.service';

const log: string[] = [];

@Injectable()
class Recorder {
  record(line: string) {
    log.push(line);
  }
}

@StepInterceptor()
@Injectable()
class TimingInterceptor implements DurableStepInterceptor {
  constructor(private readonly recorder: Recorder) {}
  async intercept(inv: StepInvocation, next: () => Promise<unknown>): Promise<unknown> {
    const result = await next();
    this.recorder.record(`${inv.workflow}.${inv.stepName}=${result}`);
    return result;
  }
}

@Workflow({ name: 'calc', version: '1' })
class CalcWorkflow {
  async run(ctx: { sideEffect: (f: () => Promise<unknown>) => Promise<number> }) {
    return ctx.sideEffect(async () => 21 * 2);
  }
}

describe('@StepInterceptor (DI-injected step middleware)', () => {
  it('discovers and wires an injectable interceptor into the engine', async () => {
    log.length = 0;
    const store = new InMemoryStateStore();
    const mod = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store, transport: new InMemoryTransport(), timerPollMs: 0 }),
      ],
      providers: [Recorder, TimingInterceptor, CalcWorkflow],
    }).compile();
    await mod.init();

    const svc = mod.get(WorkflowService);
    await svc.start('calc', {}, 'r1');
    const res = await svc.waitForRun('r1');
    expect(res.output).toBe(42);
    // The local step primitive backing `ctx.sideEffect` is always recorded under the fixed name
    // 'sideEffect' (the redesign dropped custom local-step names — see the plan's Task 1/2); the
    // interceptor still fires around it exactly as it did for the old inline `ctx.step('double', …)`.
    expect(log).toContain('calc.sideEffect=42');
  });
});
