---
'@dudousxd/nestjs-durable-core': minor
---

feat(step-logger): ergonomic `log.subProcess(name, body)` for auto-timed sub-processes

The TS `StepLogger` now has the twin of the Python SDK's `sub_process`: wrap a phase in
`await log.subProcess('export-file', () => upload())` and it records a terminal `ok` with the
measured `durationMs` on success — or `failed` (with the error message) on throw, then re-throws. The
handle exposes `sp.phase(label)` and `sp.skip(reason)`, and logs emitted inside the body are tagged
to the sub-process so the dashboard groups them under it. Returns whatever the body returns. Replaces
the manual `Date.now()` + `log.sub(name, 'ok', …, { durationMs })` pattern.
