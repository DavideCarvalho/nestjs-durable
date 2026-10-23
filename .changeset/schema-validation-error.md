---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

`SchemaValidationError`: schema failures are one error class, with the same codes, message and `details` as `@adonis-agora/durable`.

- `@Workflow({ input, output })` and `@Step({ input, output })` throw a `SchemaValidationError` (exported from core, a `FatalError`), still with `code: 'invalid_input'` / `'invalid_output'`.
- `details` changes from the issues array to `{ issues }`, and the error also has `.issues`. Each issue is `{ message, path: string[] }`; `path` is now always present (`[]` for an issue on the value itself). An alert or an onError handler reading `failure.error.details[0]` must read `failure.error.details.issues[0]`.
- A rejected `ctx.upsertSearchAttributes` write throws a `SchemaValidationError` with `code: 'schema_validation'` (it was a plain `Error`), so it is never retried and can be routed. Its message is now `invalid workflow "<name>" ctx.upsertSearchAttributes: <key>: <message>`.
- An onError route for `schema_validation` — `@OnError(SchemaValidationError)`, whose `static code` it is — also catches `invalid_input` and `invalid_output` when no route names them.
