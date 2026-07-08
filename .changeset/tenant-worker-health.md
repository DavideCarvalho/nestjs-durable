---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

The dashboard **Workers** panel now works on a tenant deployment. `workerHealth` moves onto the `RunGateway` port (joining the read/control verbs), so a store-less tenant proxies it over the transport instead of hitting the operator-only guard and throwing `This durable dashboard operation requires the control plane`. The `RunRequestResponder` — the tenant boundary — answers it scoped to the requester's own groups by the `<name>@<tenant>` queue convention, so a tenant only ever sees the health of ITS OWN queues, never another tenant's or the operator's bare groups. On the control plane the behaviour is unchanged (every group, unscoped). `metrics`/`getEvent`/`update`/`deliverWebhook` stay control-plane-only.
