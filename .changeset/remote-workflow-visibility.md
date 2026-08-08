---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-transport-bullmq': minor
---

A live worker is visible even when it announces nothing, and a version pin can fail

`announcedWorkflows()` read only the descriptor advertisement, so a fleet whose SDK predates the
handshake reported as EMPTY while it was serving work — and `resolveRemoteByConvention`, in the same
class, was routing calls to those workers off the heartbeat keys the registry ignored. Two answers
out of one Redis, disagreeing.

- The heartbeat keyspace is now a second, weaker tier of evidence. An entry exists because a live
  token of that name exists, which is exactly the condition convention routing uses, so listing it
  cannot introduce a failure the dispatcher did not already have. `AnnouncedWorkflow.evidence` says
  which tier an entry rests on: an `'observed'` entry states no version, origin or runtime, because
  a heartbeat holds none of them. A token some worker DECLARED as a step handler is excluded — that
  is a stated negative an observation cannot supply for itself.
- `engine.workflowDirectory()` adds what a list can never say: whether it is empty because nobody
  asked (no transport here can introspect), because nothing is live, or because the workers are on a
  partition this engine does not route to — the last of which reads identically to absence from the
  caller's side and is now reported instead.
- `Transport.readAllWorkerHeartbeats()` (optional, implemented by the BullMQ transport) is the read
  behind it: one scan of the liveness keyspace, keeping the instance behind each token.
- A convention-resolved remote records the version the FLEET declares. `start` used to stamp the
  synthetic run `'1'` before resolving it and the resolver echoed that straight back, so a pin of
  `'1'` could never fail and any other value could never pass. When nobody declares a version the
  routing default is kept — refusing would make an un-upgraded callee uncallable — and the run
  carries the `version:undeclared` tag so a later check can tell an assumed version from a stated
  one. Resume is unchanged: replay is positional, so an in-flight run stays on the version it began
  on.
