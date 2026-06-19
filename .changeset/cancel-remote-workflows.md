---
"@dudousxd/nestjs-durable-core": minor
---

Remote (polyglot) workflows now cancel at op boundaries. `WorkflowDecision.status` gains a `cancelled` variant: when a worker bails at an op boundary because the run was cancelled mid-turn, the engine persists the steps that ran this turn and leaves the run `cancelled` — instead of clobbering it to `failed` or resurrecting it to `suspended` (which a normal turn result would do).

Pairs with `durable-worker` (Python SDK) 0.10.0, which threads `is_cancelled` through `WorkflowContext` → each `StepContext` and auto-raises `Cancelled` at every `ctx` op boundary. A Python workflow now cancels between steps with no `if ctx.cancelled` checks in user code (mid-step interruption stays cooperative via `current_step().cancelled`). Deploy the core update together with the SDK bump: an older engine would treat a `cancelled` decision as `continue` and resurrect the run.
