---
"@dudousxd/nestjs-durable-transport-db": patch
---

DbTransport no longer runs a task twice when it outlives `leaseMs`, and a worker that lost its claim no longer deletes another instance's row.

- Every claim the instance holds is renewed every `leaseMs / 3` (the running row and the rows waiting behind it), so only a crashed or event-loop-blocked worker loses its rows.
- The task loop claims only as many rows as it has free slots. New `concurrency` option (default 1) sets how many tasks run at once.
- Claims are stamped with a per-round token. A claim is re-checked before the handler runs, and the task row is deleted and its result written in one transaction, only while that token still holds the row. The engine deletes a result row only under its own claim token.
- A result already waiting for the same `step_id` is replaced instead of kept, so a retry's result is never dropped.
- New `onError` option. A throwing result handler is reported and its row re-delivered after the lease; the rest of the batch continues.
- `instanceId` defaults to a random UUID (two instances booted in the same millisecond used to share one).
- A failed `CREATE TABLE` (two instances racing it on a fresh database) is retried instead of breaking the transport until restart.
- A non-finite numeric option (`NaN`, `Infinity`) falls back to its default instead of reaching the SQL as `LIMIT NaN`.
