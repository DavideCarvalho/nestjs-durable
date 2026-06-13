---
"@dudousxd/nestjs-durable-core": minor
---

feat: `ctx.patched(id)` — guard in-place workflow changes

Migrate a workflow without registering a new version: wrap the changed code in
`if (await ctx.patched('my-change')) { …new… } else { …old… }`. A fresh run records a `patch:<id>`
marker and takes the new branch; a run already recorded under the old code keeps the old branch,
because the marker is **position-transparent** for it (it rolls the logical position back when the
recorded history has a real step where the marker would sit) — so guarding code never shifts an
in-flight run's checkpoints and can't corrupt replay. Remove the guard once old runs have drained.
