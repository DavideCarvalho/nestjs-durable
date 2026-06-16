---
'@dudousxd/nestjs-durable-store-typeorm': patch
---

Fix MySQL TEXT (64KB) truncation: store run/checkpoint JSON blobs (`input`/`output`/`error`/`events`)
as `longtext`, and widen existing `text` columns to `longtext` on schema setup. Large fan-out steps
(many sub-process events) no longer truncate and fail to parse on read.
