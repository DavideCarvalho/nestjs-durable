---
"@dudousxd/nestjs-durable-transport-bullmq": minor
---

feat: BullMQ heartbeats over Redis pub/sub

`onHeartbeat` is no longer a no-op: the BullMQ transport now carries worker heartbeats over a
dedicated Redis pub/sub channel (`<prefix>-heartbeat`), mirroring the control plane. A worker calls
`transport.heartbeat({ runId, seq, stepId, group })` while running a long step, and the engine — on
any pod — resets that step's `timeoutMs` liveness window. (Only the in-memory `timeoutMs` path uses
heartbeats; the durable-suspend path is unaffected.)
