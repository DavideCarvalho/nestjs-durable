---
"@dudousxd/nestjs-durable-testing": minor
"@dudousxd/nestjs-durable-cli": minor
---

Replay fixtures for CI.

- The testing kit adds `captureHistory(engineOrStore, runId)`, `serializeRunHistory(history)` and `parseRunHistory(json)`. Use them to capture a run with its checkpoints as a JSON fixture, commit it, and assert it with `assertReplayable(register, parseRunHistory(json))`.
- `durable export <runId> [--out file]` writes the same fixture from your configured store.
