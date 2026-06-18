import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { runStateStoreContract } from './state-store-conformance';

// The in-memory store is the CANONICAL implementation of the StateStore contract — every SQL adapter
// must behave identically to it. Running the same shared suite against it here pins that reference
// behavior (lives in the testing package since core can't depend on testing).
runStateStoreContract('InMemoryStateStore', async () => ({
  store: new InMemoryStateStore(),
  cleanup: async () => undefined,
}));
