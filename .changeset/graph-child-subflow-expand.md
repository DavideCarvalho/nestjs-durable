---
"@dudousxd/nestjs-durable-dashboard": minor
---

Expand a child workflow inline **in the React Flow graph**. A child-workflow node now has an expand chevron (next to its `child ↗` badge); expanding renders the child run's whole flow as a lane below the parent, recursively (grandchildren get deeper lanes). An awaited child (`ctx.child`) rejoins the parent — its last step links into the parent's next node via a dashed branch — while a fire-and-forget child (`ctx.startChild`) branches below without rejoining. The step-detail panel also gains an inline child-run waterfall (and an "open ↗" link), so you can drill into a child without leaving the run.
