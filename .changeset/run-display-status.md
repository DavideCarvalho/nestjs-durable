---
'@dudousxd/nestjs-durable-dashboard': minor
---

Refine a suspended run's displayed status by *why* it's parked, instead of the catch-all `suspended`.

The engine stores one generic `suspended` for every durably-parked run (it drives recovery, timers
and queries — unchanged). But to a human those situations read very differently, so the dashboard now
derives a display status (`runDisplayStatus`): a run whose remote step a worker is executing right now
shows as **running**, a durable sleep as **sleeping**, and a wait on a signal as **awaiting**. The run
badge (list + detail) and the workflow graph's end node all use it. No engine/store change — purely
how the open run is labelled, so "a step is running but the run says suspended" stops being confusing.
