---
'@dudousxd/nestjs-durable-core': minor
---

A child workflow that FAILS TO START no longer hangs its parent in suspended-forever. Both deferred
child-start paths (the in-process ctx host and the remote `startChild` command) swallowed the
`engine.start` rejection (`.catch(() => undefined)`) — so an unregistered/unroutable child workflow
(e.g. a misconfigured remote `processing` group), an input-validation failure, or singleton
back-pressure left the parent silently parked on its `child:<id>` waiter, invisibly re-attempting on
every recovery wake. The failure mode looked exactly like a healthy long wait: no error anywhere, on
any run, ever.

Now the start failure is delivered to that waiter exactly like a failed child (`notifyParent`
with `{ ok: false }`): the awaited parent resumes and fails loudly with
`child workflow "<name>" failed to start: <cause>`. For a fire-and-forget `ctx.startChild` (no
waiter) the completion is buffered — a later join by the same id consumes it and correctly observes
the failed start. Shared via a new `startChildDeferred` engine helper; behavior for healthy children
is unchanged.
