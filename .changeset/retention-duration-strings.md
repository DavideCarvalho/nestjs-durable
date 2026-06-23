---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable-store-mikro-orm": minor
"@dudousxd/nestjs-durable": minor
---

Retention config now accepts `ms`-style duration strings (and no longer leaks raw millisecond magic numbers).

`RetentionPolicy.maxAgeMs` → **`maxAge`** and `DurableRetentionOptions.sweepIntervalMs` → **`sweepInterval`**, each now `number | string`: a number is still milliseconds, a string is parsed by the library's existing `parseDuration` (the same parser behind `ctx.sleep` / `executionTimeout`), e.g. `'30d'`, `'2w'`, `'5m'`. Note `'m'` is **minutes** (the `ms` convention) — there is no month unit, so use `'30d'` / `'90d'` for a month / quarter. Unparseable strings throw at boot (fail fast).

```ts
retention: {
  sweepInterval: '5m',
  policies: [
    { statuses: ['completed', 'cancelled'], maxAge: '30d', maxCount: 200 },
    { statuses: ['failed'], maxAge: '90d' },
  ],
}
```

This refines the retention API shipped in the previous minor (`maxAgeMs` / `sweepIntervalMs`); update those two field names if you adopted it.
