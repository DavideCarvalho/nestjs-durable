---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

`@Workflow({ input })` types and feeds the `singleton` and `concurrency` keys from the input schema.

- **Typed keys.** `Workflow` and `WorkflowOptions` are generic over the `input` schema. With one, `singleton.key`, `concurrency.key` and `validateInput` take the schema's parsed type (`StandardSchemaV1.InferOutput`, `z.output`, or a DTO class's instance), so `key: (input) => \`company:${input.companyId}\`` needs no cast and a wrong property is a compile error. Without a schema they take `unknown`, as before. `SingletonConfig<TInput>` and `ConcurrencyConfig<TInput>` gain a type parameter that defaults to `unknown`. The new `InferWorkflowInput<typeof Schema>` types `run(ctx, input)` from the same schema.
- **The keys receive the parsed input.** They used to receive the input as sent, while `run` got the parsed value. Now, with an `input` schema, every path that evaluates a key hands it the parsed value: a local start, a schedule, each turn's singleton admission (including a requeued run), a tenant start and a tenant's announced schedule. A turn's admission reuses the `singleton:<key>` tag the start stamped; a run with no such tag is admitted under the key of its parsed input, or of its stored input when that no longer parses. The run still stores the input as sent. In core this is the new `register(..., { parseInput })` option; without it nothing changes.
- The `debounce`/`batch` `key` of `@OnWorkflowCompleted` / `@OnWorkflowFailed` is unchanged: it is typed from the subscription's `input` mapping and receives what that mapping builds.
- `@dudousxd/nestjs-durable` now needs `@dudousxd/nestjs-durable-core` >= 0.104.0.
