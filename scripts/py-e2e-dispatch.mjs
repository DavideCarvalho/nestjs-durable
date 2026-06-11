// Engine side of the cross-language e2e: dispatch a checkout workflow whose remote step is
// handled by the Python worker (scripts/run_worker.py), over BullMQ/Redis.
//   node scripts/py-e2e-dispatch.mjs <prefix>
import { InMemoryStateStore, WorkflowEngine, remoteStep } from '@dudousxd/nestjs-durable-core';
import { BullMQTransport } from '@dudousxd/nestjs-durable-transport-bullmq';
import { z } from 'zod';

const prefix = process.argv[2] ?? 'durable';

const chargeCard = remoteStep({
  name: 'payments.charge-card',
  group: 'payments',
  input: z.object({ amount: z.number() }),
  output: z.object({ chargeId: z.string() }),
});

const transport = new BullMQTransport({ connection: { host: '127.0.0.1', port: 6379 }, prefix });
const engine = new WorkflowEngine({ store: new InMemoryStateStore(), transport });
engine.register('checkout', '1', async (ctx) => {
  const charge = await ctx.call(chargeCard, { amount: 99 });
  return charge.chargeId;
});

const result = await engine.start('checkout', {}, 'run1');
console.log('RESULT', JSON.stringify(result));
await transport.close();
process.exit(result.status === 'completed' && result.output === 'ch_py_99' ? 0 : 1);
