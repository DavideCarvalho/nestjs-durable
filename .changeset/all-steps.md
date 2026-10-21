---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-testing': patch
'@dudousxd/nestjs-durable': patch
---

`ctx.all` over a `@Step`: `ctx.all(this.lines.processLine, lines, { concurrency })` runs one durable step per input instead of one child workflow per input, and returns the outputs in input order. A child costs a whole run (row, turn, lease, parent signal); a step costs a checkpoint and a dispatch.

- The steps share a `parallelGroup` (`steps:<firstSeq>:<size>`), so the dashboard renders them as one fan.
- The engine adds a join barrier for steps: a result resumes the workflow only when no step of the fan is still `pending`, or when one fails. The workflow replays once per settled wave instead of once per result. `Promise.all` over `ctx.step` replays on every result, which makes a fan of N steps cost O(N²) checkpoint reads.
- `concurrency` sends the steps in waves of that size; `mode: 'failFast'` throws on the first failed step; `waitAll` (the default) throws a `GatherError` with the failed indexes once every step has settled. Every step uses the `@Step`'s retry policy, or the per-call `retries`/`backoff`. A flow-control `queue` and a liveness `timeoutMs` are rejected.
- A fan's new steps are written `pending` before any is dispatched, so a turn running concurrently with the dispatching one never sends them twice. After the dispatching turn releases its lease, it re-checks the fan, which covers a last result that another instance settled while that turn held the lease.
- New optional `StateStore.countCheckpoints(runId, fromSeq, toSeq, statuses)`, which the barrier calls on every result. MikroORM and the in-memory store implement it, `CodecStateStore` forwards it, and the shared store contract covers it. A store without it falls back to loading the run's checkpoints.
