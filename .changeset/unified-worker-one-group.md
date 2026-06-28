---
"@dudousxd/nestjs-durable-transport-bullmq": minor
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": minor
"@dudousxd/nestjs-durable": minor
---

Unified worker / one group — a much smaller surface for the "workflow + its steps" model.

- **`engine.remote(name, { group })`** — convenience form of `registerRemote`: it builds the broker
  `RemoteWorkflowExecutor` for you, so a remote (e.g. polyglot/Python) workflow is one line instead of
  hand-wiring an executor. `registerRemote` stays as the low-level escape hatch.
- **Steps inherit the workflow's group.** A `ctx.call` / `gather_calls` with no explicit group now
  dispatches to the **workflow's own group** (explicit group still wins). This is what lets a workflow
  and its steps collapse onto ONE group / ONE worker — no more "two groups for one workflow". The two
  recon facts that make this cheap: workflow turns and step calls already share one queue
  (`<prefix>-tasks-<group>`, job-name discriminated), and the worker runtime already routes both.
- **`@Step` decorator** (NestJS) — `@DurableStep` is renamed to `@Step` (kept as a deprecated alias),
  aligning the name with the Python `@worker.step`. `@Workflow` unchanged.
- **Adaptive concurrency measures only steps.** With one worker carrying both turns and steps on a
  single pool (correct — turns suspend, they don't block), the adaptive controller's latency/throughput
  window now counts only step completions, so a fast workflow turn can't corrupt the gradient.
  `AdaptiveController.onSettle` gains a `kind: 'workflow' | 'step'` argument.

The Python `durable-worker` client gains the matching unified `Worker` (one worker holds both
`@worker.workflow` and `@worker.step` on one group; `WorkflowWorker` kept as a deprecated alias for the
opt-in split). Released separately (0.16.0). See `docs/workers-when-to-use.md`.
