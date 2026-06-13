---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/nestjs-durable-transport-event-emitter": minor
"@dudousxd/nestjs-durable-transport-bullmq": minor
---

refactor!: separate the control plane from the Transport

`publishControl`/`onControl` are no longer part of `Transport`; they form a dedicated `ControlPlane`
interface, and the engine takes a separate `controlPlane` dependency. This decouples cross-instance
broadcast (lifecycle events + cancellation) from the point-to-point task transport, so you can run a
dedicated control plane (e.g. Redis pub/sub) independent of how steps are dispatched. Broadcast-capable
transports (event-emitter, BullMQ) implement `ControlPlane` too and can be passed as both; the NestJS
module auto-wires the transport as the control plane when it qualifies, or accepts an explicit
`controlPlane` option.
