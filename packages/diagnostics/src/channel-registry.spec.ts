import type { EngineEvent } from '@dudousxd/nestjs-durable-core';
import { getChannel } from '@dudousxd/nestjs-diagnostics';
import { describe, expectTypeOf, it } from 'vitest';
import './channel-registry';

describe('durable ChannelRegistry augmentation', () => {
  it('types getChannel("durable", "run.failed") payload as EngineEvent', () => {
    const channel = getChannel('durable', 'run.failed');
    channel.subscribe((msg) => {
      // The registry declaration-merge makes the published-message payload an EngineEvent.
      const event = (msg as { payload: unknown }).payload as EngineEvent;
      expectTypeOf(event.type).toEqualTypeOf<EngineEvent['type']>();
      expectTypeOf(event.runId).toBeString();
    });
  });
});
