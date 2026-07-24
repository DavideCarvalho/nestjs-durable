---
'@dudousxd/nestjs-durable-core': patch
---

fix(core): retrying a dead-lettered run now actually resurrects it

`requeue` reset the failure state its docstring promises to reset — the failed checkpoints, the stale
`error` — but left the run-level `recoveryAttempts` at the cap. A run dead-lettered at
`maxRecoveryAttempts` therefore came back `pending` and the very next `recoverIncomplete` pass
computed `cap + 1` and dead-lettered it again within seconds: the retry was accepted, the run was
re-killed with the same generic `max_recovery_attempts` error, and nothing progressed. Dead runs were
effectively unrecoverable — including via the dashboard's bulk "retry every dead run matching …",
which reported every run as applied while each was re-killed moments later.

Resurrecting a `failed`/`dead` run now clears the counter (`recoveryAttempts: 0`), completing the
run-level half of the reset the checkpoint loop already did. `0` rather than `undefined`, because
adapters disagree on what an undefined patch value means (the MikroORM and TypeORM mappers skip it,
so it would silently leave the old count in place); `0` writes a real value everywhere and reads back
identically, since `countRecovery` uses `(recoveryAttempts ?? 0) + 1`.

The reset is scoped to runs that had come to rest: requeueing a run still `running`/`suspended` is
not a resurrection, and zeroing there would let a retry loop keep a genuinely crash-looping run alive
forever. A poison pill still dead-letters after a retry spends its fresh budget. The `signal:child:`
cascade requeues failed/dead children through the same path, so their budgets are restored too.
