import {
  InMemoryStateStore,
  type RemoteStepDef,
  type Transport,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { z } from 'zod';

/** A transport that can register worker handlers (every shipped transport does). */
export type HandleableTransport = Transport & {
  handle(name: string, fn: (input: unknown) => Promise<unknown>): void;
  close?(): Promise<void>;
};

const echo: RemoteStepDef<{ n: number }, { doubled: number }> = {
  name: 'conformance.echo',
  group: 'conformance',
  input: z.object({ n: z.number() }),
  output: z.object({ doubled: z.number() }),
  __remote: true,
};

/**
 * The contract every `Transport` must satisfy: a remote step dispatched through it round-trips to a
 * worker and back (success), and a throwing handler surfaces as a failed run (failure). Point it at
 * a freshly constructed transport (engine-side + worker `group` in one instance) to prove parity —
 * useful when adding a new transport. Throws on any mismatch; closes the transport when done.
 *
 * `idPrefix` keeps run ids unique across invocations against real, shared infra (queues/tables).
 */
export async function assertTransportConformance(
  transport: HandleableTransport,
  idPrefix = 'conf',
): Promise<void> {
  try {
    // success: the worker doubles the input
    transport.handle('conformance.echo', async (input) => ({
      doubled: (input as { n: number }).n * 2,
    }));
    const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    engine.register('conf-ok', '1', async (ctx) => (await ctx.call(echo, { n: 21 })).doubled);
    const ok = await engine.start('conf-ok', {}, `${idPrefix}-ok`);
    if (ok.status !== 'completed' || ok.output !== 42) {
      throw new Error(`expected completed/42, got ${JSON.stringify(ok)}`);
    }

    // failure: a throwing handler fails the run
    const failTransport = transport; // same instance, re-register the handler to throw
    failTransport.handle('conformance.echo', async () => {
      throw new Error('handler boom');
    });
    const failEngine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
    failEngine.register('conf-fail', '1', async (ctx) => ctx.call(echo, { n: 1 }));
    const failed = await failEngine.start('conf-fail', {}, `${idPrefix}-fail`);
    if (failed.status !== 'failed') {
      throw new Error(`expected failed, got ${JSON.stringify(failed)}`);
    }
  } finally {
    await transport.close?.();
  }
}
