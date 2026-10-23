import { InMemoryTransport } from '@dudousxd/nestjs-durable-core';
import { STEP_FAN_STEP, runStepFanResultsContract } from './step-fan-results-contract';

// The reference: an in-process transport, which hands the engine every result as it lands and
// runs each task inside its `dispatch`, so it has no bulk form.
runStepFanResultsContract(
  'InMemoryTransport',
  async () => ({
    open: async (handler) => {
      const transport = new InMemoryTransport();
      transport.handle(STEP_FAN_STEP, handler);
      return { engines: [transport, transport], close: async () => {} };
    },
  }),
  { bulkDispatch: false },
);
