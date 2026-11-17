---
"@dudousxd/nestjs-durable-dashboard": minor
---

Console `apps` grant: `authorize` may return `{ allowed: true, apps: '*' | string[] }`. A list confines the console to those tenant apps (partitions): run listings, counts, facets and filter pickers, run reads and the live tail (another app's run answers 404), every action including bulk ones, worker health (`<name>@<app>` groups) and schedules (by namespace). `/metrics` answers 403 for such a viewer and a workflow's lifecycle page lists only those apps' subscriptions, without its process-wide trigger counts. `'*'` or no `apps` is every app plus the control plane's own runs, as before. `@UseConsoleAuthorize()` now also applies the `ConsoleAppScopeInterceptor` that enforces it.
