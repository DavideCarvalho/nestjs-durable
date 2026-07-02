---
'@dudousxd/nestjs-durable': patch
---

Fix operator boot crash when wiring the tenant run-gateway responder over a broker transport whose `onRunRequest`/`publishRunReply` are class methods that use private fields (e.g. `BullMQTransport`). `RunGatewayBootstrap` was passing those methods to the `RunRequestResponder` destructured/unbound, so on `onApplicationBootstrap` the responder called them with the wrong receiver and V8 threw "Receiver must be an instance of class …". The methods are now bound to the transport (matching the adjacent `publishTenantEvent.bind`).
