---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Federated console: one durable console on a central app shows the runs of several apps, each kept in its own store and executed by its own engine. `DurableDashboardModule.forRoot({ federation: { apps } })` adds an app switcher, with the selected app in the URL (`?app=<name>`, sent to the API as the `x-durable-app` header); every read and action of a request is served by that app's gateway, and an `authorize` `apps` grant names the apps a viewer may select. `federatedAppGateway({ store, transport, tenantToken? })` from `@dudousxd/nestjs-durable` builds that gateway: it reads the app's store (a read-only handle is enough) and sends cancel, retry, continue, retry-with-input, redispatch, republish, signal and schedule pause/resume/trigger to the app over its broker as run requests, which the app's own engine executes; live tails listen on the app's control channel. The run-request protocol gains `signal` and `schedule` requests, scoped to the requester's namespace like every other verb, and `RunGateway` gains optional `listSchedules`, `getSchedule`, `scheduleAction`, `signal` and `signalWaiter`, implemented by `StoreRunGateway`.
