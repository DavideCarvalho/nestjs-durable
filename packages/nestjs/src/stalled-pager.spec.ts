import {
  InMemoryStateStore,
  InMemoryTransport,
  type StalledRunInfo,
} from '@dudousxd/nestjs-durable-core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableModule, type DurableModuleOptions } from './durable.module';

/**
 * `onStalled` + `stalledAfterMs` on `DurableModule`: the listener is registered on the engine, and
 * the timer poller's sweep (its boot pass here) pages a stranded run.
 */
const modules: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(modules.splice(0).map((m) => m.close()));
});

async function bootWithStranded(
  mode: 'forRoot' | 'forRootAsync',
  extra: Partial<DurableModuleOptions>,
): Promise<StalledRunInfo[]> {
  const store = new InMemoryStateStore();
  const idle = new Date(Date.now() - 30 * 60_000);
  // Suspended with no wake timer: nothing will ever re-drive it.
  await store.createRun({
    id: 'stuck',
    workflow: 'pipeline',
    workflowVersion: '1',
    status: 'suspended',
    input: {},
    createdAt: idle,
    updatedAt: idle,
  });
  const seen: StalledRunInfo[] = [];
  const options: DurableModuleOptions = {
    store,
    transport: new InMemoryTransport(),
    timerPollMs: 0, // boot pass only
    onStalled: (info) => seen.push(info),
    ...extra,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      mode === 'forRoot'
        ? DurableModule.forRoot(options)
        : DurableModule.forRootAsync({ useFactory: async () => options }),
    ],
  }).compile();
  await moduleRef.init();
  modules.push(moduleRef);
  return seen;
}

describe.each(['forRoot', 'forRootAsync'] as const)(
  'DurableModule.%s stalled-run pager',
  (mode) => {
    it('pages a stranded run from the timer poll', async () => {
      const seen = await bootWithStranded(mode, {});
      expect(seen.map((s) => s.run.id)).toEqual(['stuck']);
      expect(seen[0]?.wakeForever).toBe(true);
    });

    it('forwards stalledAfterMs', async () => {
      const seen = await bootWithStranded(mode, { stalledAfterMs: 60 * 60_000 });
      expect(seen).toEqual([]);
    });

    it('a non-driving operator does not sweep', async () => {
      const seen = await bootWithStranded(mode, { drive: false });
      expect(seen).toEqual([]);
    });
  },
);
