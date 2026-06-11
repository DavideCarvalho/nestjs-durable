# nestjs-durable

Durable workflows for NestJS, with steps that can run across apps and languages.

Write a workflow as plain code. The engine checkpoints every step, so the flow survives
crashes and deploys and resumes exactly where it stopped. Some steps run locally in NestJS;
others run on a remote worker (Python first) — but it is **one workflow**, with **one source
of truth**, and **one end-to-end view**.

## Why

Today multi-service flows are scattered: a queue here, a queue there, a piece in Python, and
no single place to read or watch the whole flow. `nestjs-durable` collapses that into:

1. **The flow becomes code, in one place.** Read the workflow function, understand the whole
   sequence — even when steps execute in different apps.
2. **Durability.** Survives crash/deploy without re-running completed steps.
3. **End-to-end visibility.** Because one orchestrator owns the state, it knows about *every*
   step (including the Python ones), so a full-flow trace and dashboard come almost for free.

## Quick look

Define a remote step, write the workflow as plain code, and implement the step as a
provider method — it runs durably, in-process, with zero extra infrastructure:

```ts
// 1. Declare the step (typed contract, validated at the boundary)
export const chargeCard = remoteStep({
  name: 'payments.charge-card',
  input: z.object({ orderId: z.string(), amountCents: z.number().int() }),
  output: z.object({ chargeId: z.string() }),
  retries: 3,
});

// 2. The workflow — linear code; every step is checkpointed
@Workflow({ name: 'checkout', version: '1' })
class CheckoutWorkflow {
  @Step() async reserveStock(ctx: WorkflowCtx, order: Order) { /* local step */ }

  async run(ctx: WorkflowCtx, order: Order) {
    await this.reserveStock(ctx, order);
    const charge = await ctx.call(chargeCard, { orderId: order.id, amountCents: order.total });
    return charge.chargeId;
  }
}

// 3. The step handler — a provider method, decoupled from the workflow
@Injectable()
class PaymentsWorker {
  @DurableStep('payments.charge-card')
  async charge(input: { orderId: string; amountCents: number }) {
    const res = await this.stripe.charge(input.orderId, input.amountCents);
    return { chargeId: res.id };
  }
}

// 4. Wire it up — event-emitter transport = no broker, single process
DurableModule.forRootAsync({
  inject: [EventEmitter2],
  useFactory: (emitter) => ({ store: myStore, transport: new EventEmitterTransport(emitter) }),
});
```

If the process crashes mid-`checkout`, it resumes on boot from the last checkpoint —
`reserveStock` and `chargeCard` are not re-run. Swap the transport for BullMQ/NATS to move
`PaymentsWorker` into a separate process or a Python worker, with no change to the workflow.

## Status

Working core (engine, NestJS module, event-emitter transport, boot recovery) built with TDD.
See [`docs/plans`](docs/plans/2026-06-11-nestjs-durable-design.md) for the full design.

## Packages (planned)

| Package | Role |
| --- | --- |
| `@dudousxd/nestjs-durable-core` | Interfaces, engine, deterministic replay, decorators |
| `@dudousxd/nestjs-durable` | NestJS module, discovery, `WorkflowCtx`, boot recovery |
| `@dudousxd/nestjs-durable-transport-event-emitter` | In-process Transport via `@nestjs/event-emitter` (zero-infra default) |
| `@dudousxd/nestjs-durable-transport-bullmq` | Queue adapter for cross-process / cross-language steps |
| `@dudousxd/nestjs-durable-store` | `StateStore` interface + `InMemoryStore` |
| `@dudousxd/nestjs-durable-store-{prisma,typeorm,drizzle,mikro-orm}` | ORM adapters |
| `@dudousxd/nestjs-durable-otel` | OpenTelemetry instrumentation |
| `@dudousxd/nestjs-durable-dashboard` | Embedded run/timeline UI |
| `@dudousxd/nestjs-durable-testing` | Fakes, crash injection, replay assertions |
| `durable-worker` (PyPI) | Remote worker SDK |

## License

MIT
