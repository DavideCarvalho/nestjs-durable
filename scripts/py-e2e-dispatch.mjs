// Engine side of the cross-language e2e: dispatch a checkout workflow whose remote step is
// handled by the Python worker (scripts/run_worker.py), over BullMQ/Redis.
//   node scripts/py-e2e-dispatch.mjs <prefix>
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';

const prefix = process.argv[2] ?? 'durable';

const port = Number(process.env.REDIS_PORT ?? 6379);
const transport = new BullMQTransport({ connection: { host: '127.0.0.1', port }, prefix });
const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
engine.register('checkout', '1', async (ctx) => {
  // Routed by name to whichever worker registered it: the Python one in this e2e.
  const charge = await ctx.step('payments.charge-card', { amount: 99 });
  return charge.chargeId;
});

await engine.start('checkout', {}, 'run1');
// A remote step suspends the run, so start returns `pending`; wait for the Python result.
const result = await engine.waitForRun('run1', { timeoutMs: 30_000, until: 'terminal' });
console.log('RESULT', JSON.stringify(result));
await transport.close();
process.exit(result.status === 'completed' && result.output === 'ch_py_99' ? 0 : 1);
