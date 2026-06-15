---
"@dudousxd/nestjs-durable-core": minor
---

feat: CodecStateStore — encrypt / compress / redact payloads at rest

A `StateStore` decorator that runs run/step **payloads** (input + output) through a `PayloadCodec`
(encode on write, decode on read), so they're never stored in the clear — for at-rest encryption,
compression, or PII redaction. Adapter-agnostic (`new CodecStateStore(innerStore, codec)`).
Searchable metadata (id, status, workflow, tags, timestamps) and the structured `error` are left
untouched so the dashboard, queries, and recovery keep working.
