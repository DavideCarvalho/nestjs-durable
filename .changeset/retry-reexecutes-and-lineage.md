---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

**Retry of a FAILED run now re-executes its failed parts** instead of replaying deterministically
into the same failure within milliseconds. `engine.requeue` (the dashboard's Retry button) resets
the failure state first: exhausted `failed` checkpoints become retryable-now (attempts 0, wake
immediately) so the durable-retry machinery re-dispatches them fresh, and an awaited-child
`signal:child:` checkpoint holding a FAILURE completion returns to its live placeholder so replay
re-registers the child waiter. Retry a failed parent and its failed child in EITHER order — signal
buffering makes it converge (`ctx.child` now consumes an already-buffered child completion on
re-registration, closing a lost-wake where a child retried to completion could never resume its
later-retried parent).

**Dashboard: lineage navigation.** A child run's header now has an `↑ parent` chip (back to the
macro view) and a `~retry~` run links `↩ original` — both derived purely from the run id
(`<parent>.child.<seq>`, `<original>~retry~<hash>`), no wire changes.
