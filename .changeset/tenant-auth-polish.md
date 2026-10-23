---
'@dudousxd/nestjs-durable': patch
'@dudousxd/nestjs-durable-core': patch
---

Tenant tokens, follow-ups to `verifyTenant`:

- `ProxyRunGateway` rejects with an exported `RunGatewayError` whose `code` is typed (`unauthorized`, `cross-tenant`, ...). It used to be a plain `Error` with an untyped `code`.
- With a `tenantToken` provider, the request timeout now starts once the token has resolved, so a slow provider no longer eats into the control plane's deadline. A provider that rejects fails the request.
- Documented that `VerifiedTenant.capabilities` is carried but not enforced by the responder yet.
