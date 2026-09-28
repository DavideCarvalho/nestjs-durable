---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
---

**Start-time concurrency quotas.** Cap how many runs sharing a key can be in flight, and reject the
start that would exceed it — "a tenant can have at most 8 turns executing" without a hand-rolled
`SELECT count(*)` gate.

- `@Workflow({ concurrency: { key: (input) => …, limit, countStatuses? } })` (also on
  `engine.register` / `registerRemote` / `remote`), or per start with
  `StartOptions.concurrency: { key, limit, countStatuses? }` (overrides the workflow's). The key is
  global, so several workflows can share one quota; `limit` may be an async function of the key
  (per-plan limits); `countStatuses` narrows what occupies a slot (default: every non-terminal
  status — e.g. use `['pending', 'running']` so runs parked on a human don't count).
- Over the limit, `start` throws **`ConcurrencyLimitError`** (`key`, `limit`, `active`, `workflow`) and
  creates nothing. Quota-bearing runs carry the engine-minted tag `concurrency:<key>`.
- New optional **`StateStore.countRuns(query)`** — one `COUNT(*)` over the `listRuns` predicates —
  implemented by every bundled store and forwarded by `CodecStateStore`; the engine falls back to
  `runFacets`, then to a listing, for a custom store without it. Covered by the shared contract.

It is a soft cap under a race (count and insert are separate statements); use `singleton` for a strict,
queueing per-key limit.
