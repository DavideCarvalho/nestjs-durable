---
'@dudousxd/nestjs-durable-dashboard': minor
---

The console wires its filter library privately — `filterModule` is gone

0.44.0 asked hosts that already call `FilterModule.forRoot(...)` to pass
`filterModule: 'host'`, so the dashboard would not register a second global one. That option should
never have existed: it made the DEFAULT wrong for exactly the apps most likely to hit it, and wrong
SILENTLY — a second `forRoot` shadows the first's module options (validation policy, input format,
page-size ceiling) and adds a second app-wide interceptor that runs every filter in the app twice.
Nothing fails; the app just quietly stops honouring its own settings.

The dashboard now provides its own `FilterRunner` and binds `ApplyFilterInterceptor` to its own
controller, both scoped to its module. It never touches the global registration, so:

- an app that uses `@dudousxd/nestjs-filter` needs no configuration — its adapter keeps answering for
  its filters while the run gateway answers for the console's, in one process;
- an app that has never heard of the library needs no configuration either.

**Remove `filterModule` if you set it** — it was released hours ago and no longer exists.
