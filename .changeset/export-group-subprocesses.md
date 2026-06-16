---
"@dudousxd/nestjs-durable-dashboard": patch
---

Re-export `groupSubProcesses` (and the `SubProcess` type) from the `./client` entry. External consumers embedding the timeline (e.g. flip's `pipeline-runs` view) can now reconstruct a step's sub-processes the exact same way the dashboard does — grouping by run identity (`subId`/`name`) and treating `phase` events as a sub-process's lifecycle — instead of re-implementing it against the deprecated `process` tag and dropping `phase` events into a flat log list.
