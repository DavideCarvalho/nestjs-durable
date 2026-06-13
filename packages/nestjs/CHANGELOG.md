# @dudousxd/nestjs-durable

## 0.2.0

### Minor Changes

- Add a `worker` option to `DurableModule.forRoot/forRootAsync` (default `true`). Set `worker: false`
  for a **dashboard/dispatch-only** instance — typically an API pod — that mounts the control plane and
  keeps the engine available (dispatch, retry/cancel, reads) but does **not** play the worker role:
  it won't register `@DurableStep` handlers (no consuming the task queue), won't recover incomplete
  runs on boot, and won't poll due timers. Leave that to the worker instances. Lets you run the engine
  on `APP_TYPE=worker|all` and the dashboard everywhere without two instances competing to process work.
