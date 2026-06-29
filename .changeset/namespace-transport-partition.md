---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
---

feat: namespace now partitions the transport, not just the store

A durable `namespace` already isolated the STORE (a worker only recovers/resumes/times-out runs in its
own namespace). It now ALSO partitions the BullMQ TRANSPORT: every queue/stream/key name is derived
from the namespace, so multiple logical deployments can safely share ONE Redis — a developer running
locally against a shared Redis no longer collides with (or steals tasks from) the deployed workers, and
vice-versa.

- `BullMQTransport` gains a `namespace` option. All names (`<prefix>-tasks-<group>`, `-results`,
  `-decisions`, `-step-events`, the `-worker-heartbeat:` key, and the `-control` / `-heartbeat` channels)
  become `<prefix>-<namespace>-...` for a non-default namespace. A namespace that is unset or `"default"`
  → names are BYTE-IDENTICAL to before (production unchanged).
- The engine propagates its own `namespace` to the transport via a new optional `Transport.useNamespace`,
  so you set the namespace ONCE on the engine. An explicit namespace passed to the transport's
  constructor still takes precedence.
- The Python `durable-worker` gains a matching `namespace` param with the identical derivation
  (`prefix-namespace` for non-default), so a Python worker joins the same namespaced queues. Published
  separately as `durable-worker` 0.17.0.

Pair the existing store `namespace` with this to get full two-axis isolation on shared infra:
namespace → store, namespace-derived prefix → transport.
