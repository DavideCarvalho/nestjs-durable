---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/durable-worker': minor
---

Route durable work by **handler name** instead of a declared `group`, and rename the isolation axis to `partition`. The API surface shrinks and the common case needs no `group`/`groups` ceremony.

- **`ctx.remote(step, input)`** is the remote-step dispatch method; **`ctx.call` is a deprecated back-compat alias** of it (identical dispatch).
- **`RemoteStepDef.group` is replaced by optional `RemoteStepDef.partition`.** Routing is now keyed by the step's `name`; `partition` is only an isolation suffix. `remoteStep({ group })` is a deprecated alias mapped onto `partition`. The dispatched queue token is `tenantGroup(sanitizeQueueToken(name), partition)` (new `sanitizeQueueToken` replaces `:` with `-`, which BullMQ forbids in queue names; exported from the package root).
- **Workers subscribe per registered handler name, not per group.** `DurableWorkerModule` derives its subscriptions from the discovered `@Workflow`/`@Step` — `groups` is now optional/deprecated (ignored) and `tenant` is a deprecated alias for the new `partition`. `BullMQTransport` starts one consumer per registered handler (its `group` option is a deprecated alias for `partition`). The thin `runRedisWorker` and `DurableWorkerRuntime.registeredNames()` back this. In-app group-served workflows dispatch each turn under their own name-derived token.
- **Execution model is unchanged** (stateless replay-per-turn) and now regression-locked.

Migration is non-breaking via the deprecation aliases above — each consumer's source migrates independently. **The wire format (queue naming) is a coordinated atomic change:** the durable fleet (operator + every runtime worker, JS and Python) must deploy together for this release, as it already must for any routing change.

**Known limitation (follow-up):** only `BullMQTransport` is migrated to per-handler subscription. `DbTransport` and `SqsTransport` still use the flat single-`group` consumer model (they interoperate with the new engine because dispatch carries the computed token, but a worker instance serves one token, not one-per-handler). SQS additionally rejects `.` in queue names, which `sanitizeQueueToken` does not strip. Migrate these if/when needed.
