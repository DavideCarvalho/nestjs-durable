---
"@dudousxd/nestjs-durable-telescope": patch
---

The Workflows panels (success rate, throughput, durations, runs over time) keep counting runs after a
wide step fan. They read the latest 5,000 `durable` entries and counted the `run.*` events among
them, but one 40k-step fan records 80k step entries, so for hours afterwards the page held only steps
and every panel showed no runs. Run lifecycle entries now carry a `familyHash` (`durable:run.started`,
`durable:run.completed`, …), an indexed column on every Telescope store, and the panels read those
families directly. Entries recorded before this release are still read the old way while no run
entry has a family yet.
