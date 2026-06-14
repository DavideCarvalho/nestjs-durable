import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Workflow } from './decorators';
import { DurableModule } from './durable.module';
import { WorkflowService } from './workflow.service';

@Workflow({ name: 'tagged', version: '1', tags: ['etl', 'critical'] })
class TaggedWorkflow {
  async run() {
    return 'ok';
  }
}

describe('@Workflow tags', () => {
  it('stamps static tags merged with per-run tags onto the run', async () => {
    const store = new InMemoryStateStore();
    const moduleRef = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, timerPollMs: 0 })],
      providers: [TaggedWorkflow],
    }).compile();
    await moduleRef.init();

    const svc = moduleRef.get(WorkflowService);
    await svc.start('tagged', {}, 'r1', { tags: ['nightly'] });

    expect((await store.getRun('r1'))?.tags).toEqual(['etl', 'critical', 'nightly']);
    expect((await store.listRuns({ tag: 'etl' })).map((r) => r.id)).toEqual(['r1']);
  });
});
