---
'@dudousxd/nestjs-durable-store-typeorm': patch
---

Fix MySQL TEXT (64KB) truncation: store run/checkpoint JSON blobs (`input`/`output`/`error`/`events`)
as `longtext`, and widen existing `text` columns to `longtext` on schema setup. Large fan-out steps
(many sub-process events) no longer truncate and fail to parse on read.

Also tolerate corrupt/truncated JSON columns on read: a row whose blob was already truncated by the
old TEXT limit (or is otherwise invalid) now degrades that single field to `undefined` instead of
failing the whole run read. One bad row no longer 500s the run-detail endpoint.
