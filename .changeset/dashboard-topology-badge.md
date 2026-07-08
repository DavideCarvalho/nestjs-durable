---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

The dashboard header now shows the deployment's durable **role** — "control plane" or "tenant · <partition>" — instead of a hardcoded "control plane" label (which was wrong on a tenant). `RunGateway` gains a synchronous `topology(): DurableTopology` (`{ role: 'control-plane' | 'tenant'; tenant? }`): the store-backed gateway reports `control-plane`, the `ProxyRunGateway` reports `tenant` with its partition name. Exposed via `GET /api/durable/topology` and rendered as a header badge (tenant highlighted amber). No round-trip — it's local metadata each gateway already holds.
