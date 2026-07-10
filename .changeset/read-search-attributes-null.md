---
"@dudousxd/nestjs-durable-core": patch
---

`readSearchAttributes` accepts a run whose `searchAttributes` is `null` (the nullable JSON column shape every ORM store entity exposes), not just `undefined`.
