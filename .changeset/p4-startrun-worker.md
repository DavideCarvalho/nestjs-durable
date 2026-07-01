---
'@dudousxd/durable-worker': minor
---

Add `startRun(connection, opts)` function (P4 — tenant worker → control plane). Publishes a `StartRunMessage` onto `<effectivePrefix>-start-run` using BullMQ, supporting the namespace-prefix rule via the new `effectivePrefixOf` helper. Also exports `effectivePrefixOf` and `startRunName` from `runner-core` for callers that need to compute names directly.
