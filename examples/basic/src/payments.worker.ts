import { Step } from '@dudousxd/nestjs-durable';
import { Injectable } from '@nestjs/common';

/**
 * The step handlers `CheckoutWorkflow` dispatches to. Decoupled from the workflow — each method just
 * implements one step; the engine gives every one of them checkpointing + exactly-once semantics
 * (retries too, on a `@Step` that opts in). All three happen to run in THIS process (via the
 * event-emitter transport), but nothing about the workflow code would change if `charge` moved to a
 * separate Python/Node worker over BullMQ — `ctx.step` dispatches by name either way. That's the
 * point of collapsing "local" and "remote" into one always-dispatched `ctx.step`.
 */
@Injectable()
export class PaymentsWorker {
  @Step()
  async reserveStock(_order: { id: string; total: number }): Promise<{ reserved: boolean }> {
    // reserve inventory for order.id
    return { reserved: true };
  }

  @Step('payments.charge-card')
  async charge(input: { orderId: string; amountCents: number }): Promise<{ chargeId: string }> {
    // await stripe.charge(...)
    return { chargeId: `ch_${input.orderId}_${input.amountCents}` };
  }

  @Step()
  async ship(_order: { id: string; total: number }): Promise<{ shipped: boolean }> {
    // hand off to the carrier
    return { shipped: true };
  }
}
