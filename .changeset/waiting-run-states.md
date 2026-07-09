---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/nestjs-durable': patch
'@dudousxd/nestjs-durable-dashboard': patch
---

Make a suspended run's WHY legible in the `/durable` dashboard. The engine keeps one generic
`suspended` for every durably-parked run, so the list used to show one flat badge whether a run was
waiting on a signal, blocked with no worker, or queued behind a singleton leader. Now:

- **Waiting on what** — the control plane resolves each suspended run's event wait from its signal
  waiters (one bulk `listSignalWaiters` scan, no per-run timeline fetch) and names it in the list row:
  `signal <name>` / `webhook <token>` / `child <id>` (new `RunWaiting` on the gateway's `RunListItem`,
  classified by waiter-token prefix — `wh:` / `child:` / `event:` — via the new `classifyWaiterToken`).
- **No worker** — a run whose handler has no live worker is flagged `no-worker` (joined against the
  Workers panel's health), with a header banner listing the stalled workflows, so "control plane up
  but nothing consuming the queue" is obvious at a glance instead of looking like a normal sleep.
- **Queued behind a singleton** — runs sharing a `singleton:<key>` tag show the leader as running and
  the rest as `queued`, naming the leader — derived entirely client-side (the engine already stamps
  the tag), mirroring the admission order.

All states re-derive on the existing poll, so they flip to `running` on their own the moment a worker
rejoins or the leader settles. Deliberately event-only on the server (no timer/step guess): `wakeAt`
alone can't tell a real `ctx.sleep` from the reconcile-fallback `wakeAt` an event/step suspend now
carries, so a non-event suspend with a live worker shows as `running` rather than a misleading
"sleeping" — the detail view (which has the timeline) still distinguishes them precisely.
