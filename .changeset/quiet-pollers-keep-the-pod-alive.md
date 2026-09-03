---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/nestjs-durable': patch
---

Stop a single unrecoverable run from crash-looping every worker.

`TimerPoller.poll()` and `RetentionPoller.sweep()` are awaited inside
`onApplicationBootstrap` and fired as `void` on an interval, so a rejection out of
either one was fatal twice over — it propagated through `NestApplication.init()` into
the host's `bootstrap()`, and on the interval it surfaced as an unhandled rejection.
Because the state that caused it survived the restart, one bad row in the run store
took the pod down on every boot, stopping every other workflow in the deployment with
it. Both sweeps now absorb and report their failures, per sub-sweep, so a poll that
goes wrong costs that tick and nothing more.

`WorkflowEngine.resumeLeased` no longer lets one run end the batch either. A leased
batch is a mixed bag during a rolling deploy — skew protection makes `resume` throw for
the workflows a pod does not have — and aborting there meant a single run stopped
recovery for every run behind it. Such a run is now skipped and left for an instance
that can drive it, which is what the skew-protection error asks for.
