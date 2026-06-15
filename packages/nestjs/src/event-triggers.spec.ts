import 'reflect-metadata';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { OnEvent, Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

@Workflow({ name: 'welcome', version: '1', onEvent: ['user.registered'] })
class WelcomeWorkflow {
  async run(_ctx: unknown, input: { email: string }) {
    return `welcome ${input.email}`;
  }
}

@Workflow({ name: 'audit', version: '1' })
@OnEvent('user.registered', 'user.deleted')
class AuditWorkflow {
  async run(_ctx: unknown, input: { kind: string }) {
    return input.kind;
  }
}

describe('event triggers (@Workflow onEvent + @OnEvent decorator)', () => {
  it('starts workflows subscribed via both the option and the decorator', async () => {
    const store = new InMemoryStateStore();
    const mod = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, timerPollMs: 0 })],
      providers: [WelcomeWorkflow, AuditWorkflow],
    }).compile();
    await mod.init();
    const svc = mod.get(WorkflowService);

    const touched = await svc.publishEvent(
      'user.registered',
      { email: 'a@b.com', kind: 'new' },
      {
        id: 'u1',
      },
    );
    expect(touched).toBe(2); // welcome (option) + audit (decorator)
    expect((await store.getRun('evt:u1:welcome'))?.output).toBe('welcome a@b.com');
    expect((await store.getRun('evt:u1:audit'))?.output).toBe('new');

    // The decorator's second event also triggers audit (and not welcome).
    await svc.publishEvent('user.deleted', { kind: 'gone' }, { id: 'd1' });
    expect((await store.getRun('evt:d1:audit'))?.output).toBe('gone');
    expect(await store.getRun('evt:d1:welcome')).toBeNull();
  });
});
