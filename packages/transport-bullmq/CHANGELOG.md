# @dudousxd/nestjs-durable-transport-bullmq

## 1.0.0

### Patch Changes

- Updated dependencies [4762866]
- Updated dependencies [c648786]
- Updated dependencies [f1e7999]
- Updated dependencies [f1679e5]
- Updated dependencies [46c293b]
  - @dudousxd/nestjs-durable-core@1.0.0

## 0.3.0

### Minor Changes

- e736e31: feat: BullMQ heartbeats over Redis pub/sub

  `onHeartbeat` is no longer a no-op: the BullMQ transport now carries worker heartbeats over a
  dedicated Redis pub/sub channel (`<prefix>-heartbeat`), mirroring the control plane. A worker calls
  `transport.heartbeat({ runId, seq, stepId, group })` while running a long step, and the engine — on
  any pod — resets that step's `timeoutMs` liveness window. (Only the in-memory `timeoutMs` path uses
  heartbeats; the durable-suspend path is unaffected.)

- 6836ace: refactor!: separate the control plane from the Transport

  `publishControl`/`onControl` are no longer part of `Transport`; they form a dedicated `ControlPlane`
  interface, and the engine takes a separate `controlPlane` dependency. This decouples cross-instance
  broadcast (lifecycle events + cancellation) from the point-to-point task transport, so you can run a
  dedicated control plane (e.g. Redis pub/sub) independent of how steps are dispatched. Broadcast-capable
  transports (event-emitter, BullMQ) implement `ControlPlane` too and can be passed as both; the NestJS
  module auto-wires the transport as the control plane when it qualifies, or accepts an explicit
  `controlPlane` option.

## 0.2.0

### Minor Changes

- **Transport control plane** — a broadcast pub/sub across all engine instances, unlocking the cross-pod features from the durability audit:

  - `Transport.publishControl(msg)` / `onControl(handler)` + a `ControlMessage` type. In-process transports (in-memory, event-emitter) broadcast locally; **BullMQ broadcasts over Redis pub/sub**. Optional — the engine degrades to local-only when a transport doesn't implement it.
  - **Cross-pod live-tail**: the engine now broadcasts lifecycle events, so a dashboard-only pod (`worker: false`) sees events from a run executing on a worker pod. The dashboard exposes `@Sse('runs/:id/stream')` and `durableClient.streamRun(id, onEvent)` — live updates without polling.
  - **Cooperative cancellation**: `engine.cancel(runId)` broadcasts the cancel; `engine.onCancel(fn)` lets a worker bridge abort in-flight work instead of finishing it just to have the result discarded. Events are deduped by originating `instanceId` so a broker echo doesn't double-deliver.
