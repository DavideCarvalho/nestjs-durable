import { Workflow } from '@dudousxd/nestjs-durable';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { chargeCard } from './checkout.steps';

export interface Order {
  id: string;
  total: number;
}

/**
 * A checkout written as plain, linear code. Every step is checkpointed, so a crash/deploy
 * mid-run resumes exactly where it stopped. The flow spans a local step, a remote step
 * (handled by PaymentsWorker), a human-approval signal, and a final local step — one workflow,
 * one source of truth, one timeline in the dashboard.
 */
@Workflow({ name: 'checkout', version: '1' })
export class CheckoutWorkflow {
  async run(ctx: WorkflowCtx, order: Order) {
    await ctx.step('reserveStock', async () => {
      // reserve inventory for order.id
      return { reserved: true };
    });

    const charge = await ctx.call(chargeCard, {
      orderId: order.id,
      amountCents: order.total,
    });

    // Pause — possibly for days — until a human approves. No compute consumed while waiting.
    const approval = await ctx.waitForSignal<{ approved: boolean }>(`approve:${order.id}`);
    if (!approval.approved) {
      return { status: 'rejected' as const, chargeId: charge.chargeId };
    }

    await ctx.step('ship', async () => {
      // hand off to the carrier
      return { shipped: true };
    });

    return { status: 'shipped' as const, chargeId: charge.chargeId };
  }
}
