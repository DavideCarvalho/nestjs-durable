import { DurableStep } from '@dudousxd/nestjs-durable';
import { Injectable } from '@nestjs/common';

/**
 * The step handler. Decoupled from the workflow: it just implements `payments.charge-card`.
 * In a real app this would call Stripe; the engine gives it retries and exactly-once semantics.
 */
@Injectable()
export class PaymentsWorker {
  @DurableStep('payments.charge-card')
  async charge(input: { orderId: string; amountCents: number }): Promise<{ chargeId: string }> {
    // await stripe.charge(...)
    return { chargeId: `ch_${input.orderId}_${input.amountCents}` };
  }
}
