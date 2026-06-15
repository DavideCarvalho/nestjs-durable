import 'reflect-metadata';
import type { StepInvocation } from '@dudousxd/nestjs-durable-core';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
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
  async run(ctx: { step: (n: string, f: () => Promise<unknown>) => Promise<number> }) {
    return ctx.step('double', async () => 21 * 2);
  }
}

describe('@StepInterceptor (DI-injected step middleware)', () => {
  it('discovers and wires an injectable interceptor into the engine', async () => {
    log.length = 0;
    const store = new InMemoryStateStore();
    const mod = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, timerPollMs: 0 })],
      providers: [Recorder, TimingInterceptor, CalcWorkflow],
    }).compile();
    await mod.init();

    const svc = mod.get(WorkflowService);
    await svc.start('calc', {}, 'r1');
    const res = await svc.waitForRun('r1');
    expect(res.output).toBe(42);
    expect(log).toContain('calc.double=42');
  });
});
