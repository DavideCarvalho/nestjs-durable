---
'@dudousxd/nestjs-durable-dashboard': minor
---

Console kit r3. ⌘K now navigates: it lists every page of the sidebar (Runs, Workers, Schedules; also found by "executions", "nodes", "cron") and every other Aviary console you can open ("Go to Agents", found by "agent" too), matched case- and accent-insensitively and forgiving plural endings, before the cross-console search hits. ⌘K keeps working for pages and consoles when the app doesn't serve `/consoles/search`; the trigger is then labelled "Search". The sidebar spacing matches the authkit admin console (32px nav rows, 69px brand header, left-aligned theme toggle). The kit also gains charts on TanStack Charts (`aviary-kit/charts`: TimeSeriesChart, BarChart, Sparkline, DonutChart) with a themed tooltip on hover and keyboard focus; this console draws no chart yet, so its JS bundle stays the same.
