import { InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { STEP_FAN_STEP, runStepFanResultsContract } from './step-fan-results-contract';

// The reference: an in-process transport, which hands the engine every result as it lands.
runStepFanResultsContract('InMemoryTransport', async () => ({
  open: async (handler) => {
    const transport = new InMemoryTransport();
    transport.handle(STEP_FAN_STEP, handler);
    return { engines: [transport, transport], close: async () => {} };
  },
}));
