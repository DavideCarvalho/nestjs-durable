import type { DurableWorkerRuntime } from '@dudousxd/durable-worker';

/** The `@dudousxd/durable-worker` module shape. `typeof import()` is erased, so this costs nothing. */
type WorkerSdk = typeof import('@dudousxd/durable-worker');

/**
 * The single gate to `@dudousxd/durable-worker`. It is an OPTIONAL peer because only the roles that
 * EXECUTE workflow bodies need it — a pure operator (`store` + `transport`, no `connection`) never
 * runs a worker and is entitled to install without it. A static import would resolve it for every
 * consumer at `import '@dudousxd/nestjs-durable'`, so such an operator would die at boot with
 * `ERR_MODULE_NOT_FOUND` on a package it was told was optional.
 *
 * Every value from the SDK therefore crosses this module and nothing here is reachable from an
 * import of the package entry. Node caches the resolved module, so each call after the first is a
 * cache hit; the call sites below are per-`start` or per-bootstrap, never per-turn. Mirrors how
 * `@dudousxd/durable-worker` itself reaches its own optional `bullmq`/`ioredis` peers.
 */
async function workerSdk(): Promise<WorkerSdk> {
  try {
    return await import('@dudousxd/durable-worker');
  } catch (cause) {
    throw new Error(
      '@dudousxd/durable-worker is not installed. It is an optional peer needed only by the roles that run workflow bodies (`connection` set on DurableModule.forRoot) — install it, or drop `connection`.',
      { cause },
    );
  }
}

/** Publish a `StartRunMessage` on the shared start-run queue. One import per `start`, then cached. */
export const startRun: WorkerSdk['startRun'] = async (connection, options) =>
  (await workerSdk()).startRun(connection, options);

/** Start a BullMQ consumer for a runtime's registered names. Called once, on app bootstrap. */
export const runRedisWorker: WorkerSdk['runRedisWorker'] = async (options) =>
  (await workerSdk()).runRedisWorker(options);

/** Construct the store-less runtime a worker registers its bodies on. Called once, per role gate. */
export async function createWorkerRuntime(
  options: ConstructorParameters<WorkerSdk['DurableWorkerRuntime']>[0],
): Promise<DurableWorkerRuntime> {
  const { DurableWorkerRuntime: Runtime } = await workerSdk();
  return new Runtime(options);
}
