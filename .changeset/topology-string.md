---
"@dudousxd/nestjs-durable": minor
---

**Breaking:** `topology` is now the string Agora uses, `'standalone' | 'control-plane' | 'tenant'`, and the nested `tenant` field moved to `partition`.

```ts
// Before
DurableModule.forRoot({ topology: { role: 'control-plane', tenant: 'davi-local' }, store, transport });
DurableModule.forRoot({ topology: { role: 'tenant', tenant: 'acme-corp' }, connection });

// After
DurableModule.forRoot({ topology: 'control-plane', partition: 'davi-local', store, transport });
DurableModule.forRoot({ topology: 'tenant', partition: 'acme-corp', connection });
```

`'standalone'` (the default) keeps the role inference from `store`/`connection`. The options are a union discriminated on `topology`: with `'tenant'`, `store`, `namespace` and `verifyTenant` are type errors and `partition` is required. On a control plane, `partition` becomes its namespace, as `tenant` did. The object form throws at boot with the new form in the message. The wire is unchanged.
