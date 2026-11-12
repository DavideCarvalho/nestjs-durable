---
"@dudousxd/nestjs-durable": minor
---

`verifyTenant` and `tenantToken` accept classes. Implement `TenantVerifierContract` (`verify({ token, tenant })`) on the control plane and `TenantCredentialsContract` (`token()`) on the tenant, and pass the class, an object, or a lazy import of a module whose default export is one:

```ts
DurableModule.forRoot({ topology: 'control-plane', store, transport, verifyTenant: JwtTenantVerifier });
DurableModule.forRoot({ topology: 'tenant', partition: 'acme', connection, transport, tenantToken: () => import('./tenant-credentials.js') });
```

A class is built once through Nest DI (the registered provider when there is one, else `ModuleRef.create`); a lazy import runs once. Functions and strings work as before, and `hmacTenantVerifier` / `signTenantToken` are unchanged. A token source that returns an empty string now fails that request, and a static `tenantToken: ''` fails at boot. `verifyTenant` on a `'tenant'` process and `tenantToken` on a `'control-plane'` throw at boot. The new "Authenticate tenants" guide has working classes for your own `@nestjs/jwt` tokens, any OIDC provider, and HMAC.
