---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
'@dudousxd/nestjs-durable': minor
---

Store-less cluster handshake & capability negotiation (wire-compatible with the Adonis `@adonis-agora/durable` port and the Python `durable-worker` client — proven with live bidirectional interop).

**core**
- New handshake layer: a worker advertises a two-tier `WorkerDescriptor` (a stable `descriptorHash` over its declared capabilities + supported workflow requirements) and the control plane runs `negotiate()`, classifying each worker as `compatible` / `degraded` / `incompatible`. Capability-aware dispatch routing parks a run as `blocked` when no capable/compatible worker is registered instead of hanging or dead-lettering it — the run resumes automatically once a matching worker appears.
- `LEGACY_V1_CAPABILITIES` lets a pre-handshake worker (no descriptor) be treated as a known-capability baseline rather than rejected, so rolling upgrades never strand runs.

**transport-bullmq**
- The BullMQ transport now advertises the handshake descriptor over a `-worker-descriptor:<token>:<instance>` channel and the control plane consumes it during negotiation — byte-compatible with the aviary wire so an Adonis or Python worker can join the same control plane.

**nestjs**
- `@Step({ requires })` / `@Workflow({ requires })` capability-authoring surface: declare the capabilities a step/workflow needs so the handshake can route it only to workers that support them.

Also guards the in-memory (`timeoutMs`) step-dispatch path so a capability mismatch there parks rather than silently mis-dispatches.
