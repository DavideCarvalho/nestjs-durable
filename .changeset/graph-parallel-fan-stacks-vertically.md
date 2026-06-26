---
"@dudousxd/nestjs-durable-dashboard": patch
---

Stack parallel-fan steps vertically in the run-detail workflow graph. The `WorkflowGraph` (ReactFlow) laid every step out left-to-right and chained them with solid main-flow edges, so a `ctx.gather`/`ctx.all` fan-out — N siblings the engine tags with the same `parallelGroup` (e.g. a `processing` run's 7 `handle_*` handlers, or a `Promise.all` of `ctx.child` siblings) — rendered as a misleading horizontal `start → s1 → … → sN → end` chain, reading as if each step spawned the next. The graph now reuses `groupParallelSpans` (already powering the spans gantt) and lays each fan's members in a single column, stacked one below the other, with `start`/previous step fanning OUT to every member and every member fanning IN to whatever follows — so concurrent steps read as concurrent, not as a parent→child sequence. Sequential steps are unchanged.
