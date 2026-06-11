import { remoteStep } from '@dudousxd/nestjs-durable-core';
import { z } from 'zod';

/**
 * A typed handle to a step that runs on a worker. Here the worker is a `@DurableStep` provider
 * in this same process (via the event-emitter transport); swap the transport for BullMQ/NATS to
 * move it to another process or a Python worker — the workflow code below stays identical.
 */
export const chargeCard = remoteStep({
  name: 'payments.charge-card',
  input: z.object({ orderId: z.string(), amountCents: z.number().int() }),
  output: z.object({ chargeId: z.string() }),
  retries: 3,
});
