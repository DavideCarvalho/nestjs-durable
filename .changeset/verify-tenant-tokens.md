---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
---

Signed tenant tokens for the store-less cluster, wire-compatible with Agora. A control plane can set `verifyTenant` (e.g. `hmacTenantVerifier(secret)`) on `DurableModule.forRoot`: the `tenant` on each incoming run request and start-run is then treated as a signed token, the tenant is derived from it, and an invalid, tampered or missing token gets an `unauthorized` error reply (run requests) or creates no run (start-runs). Tenant pods present their token with the new `tenantToken` option (a string, or a function called before every request), minted by `signTenantToken(tenant, secret, { ttlMs? })`. Tokens and the `unauthorized` reply are byte-identical to Agora's, so the two libraries interoperate. Both options are optional: without them the wire `tenant` is trusted verbatim, as before. An explicit `topology: { role: 'control-plane' }` without a verifier now logs a warning at boot; a plain operator boots silently. `ProxyRunGateway` errors now carry the reply's `code`.
