---
'@dudousxd/nestjs-durable-core': minor
---

A turn no longer looks for wake requests kept as buffered signals, the format engines before 0.85.10 used; since 0.85.10 they are buffered events. That read was a `DELETE … RETURNING` after every turn (6 statements per 5-step workflow). Upgrading straight from a core older than 0.85.10, don't roll old and new engines together: stop the old ones first, or run 0.85.10–0.87.x in between.
