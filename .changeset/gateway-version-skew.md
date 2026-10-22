---
"@dudousxd/nestjs-durable": patch
---

Run detail keeps working while a tenant pod and the control plane are on different releases. A tenant's `ProxyRunGateway` talking to a control plane from before summarized details (0.46.x) now summarizes the full detail itself, and pages a fan out of the full detail when the control plane does not know `getFanMembers`. It reads the old responder from its reply, with no timeout wait, and remembers it for a minute (the new optional fourth constructor argument, `capabilityTtlMs`). The `RunRequestResponder` answers a request kind it does not know with an `unsupported-request` error before touching the store. When its gateway throws, it replies with the error instead of leaving the tenant to time out. Old tenants get the same answers as before.
