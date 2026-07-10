---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

**`RunDetail` single-sourced from core.** `RunDetail` (a run + its timeline + child ids) was
independently re-declared three times — core's `RunGateway` port, the dashboard server's
`DashboardService`, and the dashboard client's SPA mirror (with its own client-local `WorkflowRun`/
`StepCheckpoint` types on top) — free to drift out of sync on any future field addition.

Core adds `WireDates<T>`, a small mapped type that turns every `Date` (and `Date | undefined`) field
of a server type into its ISO-string wire form, preserving each field's own optional modifier. The
dashboard server now imports and re-exports core's `RunDetail` instead of re-declaring it (no behavior
change — same shape, same export). The dashboard client's SPA `WorkflowRun`/`StepCheckpoint`/
`RunDetail`/`StepEvent`/`RunWaiting` are now derived from the core types via `WireDates` (type-only
imports; erased at build) instead of hand-mirrored field by field, so a new core field now shows up on
the client automatically. A few fields stay deliberately client-local and are documented inline where
they diverge (`StepCheckpoint.enqueuedAt` and `WorkflowRun.input` stay optional against core's
required equivalents; `error` widens to the real `StepError` shape; `RunDetail.children` stays
optional) — none of these change the client's public type surface for existing consumers.
