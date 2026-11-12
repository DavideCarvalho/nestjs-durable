---
"@dudousxd/nestjs-durable-dashboard": minor
---

The console registers its reads (runs, a run, fan members, counts, health, workers, schedules, run events) and its run and schedule actions (retry, cancel, continue, signal, trigger, pause) as developer tools on the agent MCP server's dev endpoint, gated by its `authorize` and served through `DashboardService`. New `devTools` option. It joins the Aviary console switcher: `GET <api>/consoles`, a `switcher` field in the page's `durable-dashboard-config` block, and the brand becomes a menu of the consoles the viewer may open. New `anyAuthorize(...forms)`; an allow may name its `caller`.
