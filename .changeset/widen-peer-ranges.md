---
"@dudousxd/nestjs-durable": patch
"@dudousxd/nestjs-durable-telescope": patch
"@dudousxd/nestjs-durable-diagnostics": patch
---

Widen peer ranges so apps on the current releases install without peer conflicts: `@dudousxd/nestjs-durable` accepts `@dudousxd/nestjs-context` 1.x (`>=0.1.0 <2.0.0`), `@dudousxd/nestjs-durable-telescope` accepts `@dudousxd/nestjs-telescope` 2.x (`>=1.0.0 <3.0.0`), and `@dudousxd/nestjs-durable-diagnostics` accepts `@dudousxd/nestjs-diagnostics` 0.3 to 0.8 and later 0.x (`>=0.3.0 <1.0.0`, previously `^0.3.0`). No code changes: the APIs these packages use are unchanged in context 1.1.0, telescope 2.0 and diagnostics 0.8.0.
