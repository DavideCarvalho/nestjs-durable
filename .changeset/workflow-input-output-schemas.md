---
"@dudousxd/nestjs-durable": minor
---

`@Workflow({ input, output })`: the schema options `@Step` already had, now on the workflow too.

- `input` and `output` accept a Standard Schema (zod 3.24+, valibot, arktype, …) or a class-validator DTO class. `@Step({ input, output })` accepts the same forms; it used to take zod only, and a zod schema older than 3.24 still works.
- The input is checked at `start`, so invalid input creates no run. The run stores the input as it was sent. `run(ctx, input)` receives the parsed value (a `Date` from `z.coerce.date()`, a DTO instance), re-parsed before every turn, so a replay sees the same value the first execution did. The schema must be deterministic, and changing it means bumping the workflow's `version`.
- `output` parses the value `run()` returns before the run completes and stores the parsed value.
- A value that does not match fails with a `FatalError` (never retried) with `code: 'invalid_input'` or `'invalid_output'` and the schema's issues as `details`. A run whose stored input no longer parses fails with `invalid_input`.
- `inputSchema` stays, as an alias of `input`. Setting both is an error.

Behaviour changes for existing workflows and steps:

- A workflow with `inputSchema` now receives a DTO instance in `run()`, not the plain object. Properties the DTO does not declare are stripped (`whitelist: true`), as they already were during validation.
- `validateInput` no longer replaces `inputSchema`: when both are set, the schema is checked first and then `validateInput` runs.
- A `@Step` whose input or output fails its schema throws a `FatalError` with `code: 'invalid_input'` / `'invalid_output'` instead of a `ZodError`, so it is no longer retried.
- The error message for invalid input changed from `invalid input for workflow: …` to `invalid workflow "<name>" input: …`.
