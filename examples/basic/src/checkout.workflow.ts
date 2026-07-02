import { Workflow } from '@dudousxd/nestjs-durable';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { PaymentsWorker } from './payments.worker';

export interface Order {
  id: string;
  total: number;
}

/**
 * A checkout written as plain, linear code. Every step is checkpointed, so a crash/deploy
 * mid-run resumes exactly where it stopped. The flow spans three dispatched steps (all served by
 * `PaymentsWorker` in this process via the event-emitter transport — a separate/remote worker would
 * look identical from here) and a human-approval signal in between — one workflow, one source of
 * truth, one timeline in the dashboard.
 */
@Workflow({ name: 'checkout', version: '1' })
export class CheckoutWorkflow {
  constructor(private readonly payments: PaymentsWorker) {}

  async run(ctx: WorkflowCtx, order: Order) {
    await ctx.step(this.payments.reserveStock, order);

    const charge = await ctx.step(this.payments.charge, {
      orderId: order.id,
      amountCents: order.total,
    });

    // Pause — possibly for days — until a human approves. No compute consumed while waiting.
    const approval = await ctx.waitForSignal<{ approved: boolean }>(`approve:${order.id}`);
    if (!approval.approved) {
      return { status: 'rejected' as const, chargeId: charge.chargeId };
    }

    await ctx.step(this.payments.ship, order);

    return { status: 'shipped' as const, chargeId: charge.chargeId };
  }
}
