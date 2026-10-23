import { InMemoryRunQueue } from '@dudousxd/nestjs-durable-core';
import { runRunDispatchContract } from './run-dispatch-contract';

// The reference implementation: an in-process queue shared by two transports.
runRunDispatchContract('InMemoryRunQueue', async () => ({
  pair: async () => {
    const queue = new InMemoryRunQueue();
    return [queue.transport(), queue.transport()];
  },
}));
