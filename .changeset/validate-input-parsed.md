---
"@dudousxd/nestjs-durable": minor
---

`@Workflow({ validateInput })` now receives the value the `input` schema parsed, not the input as sent: a `Date` from `z.coerce.date()`, a DTO instance. Without an `input` schema it still receives the input as sent. The run still stores the input as sent. This matches `@dudousxd/adonis-agora-durable`.

A `validateInput` that relied on the raw shape (a date as a string, a field the DTO strips with `whitelist: true`) now sees the parsed shape.
