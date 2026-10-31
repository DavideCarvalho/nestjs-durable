---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/nestjs-durable-testing': patch
'@dudousxd/nestjs-durable-store-drizzle': patch
'@dudousxd/nestjs-durable-store-typeorm': patch
'@dudousxd/nestjs-durable-store-mikro-orm': patch
'@dudousxd/nestjs-durable-store-prisma': patch
---

Singleton admission no longer deadlocks. A claim row-locked every active run of the workflow in no particular order, so concurrent claims could lock in opposite orders; the database killed one (Postgres `40P01`) and its run stayed leased until the lease lapsed. A claim now locks only the active runs of its own key, ordered by id, on Postgres and MySQL, so claims queue and different keys never wait for each other. SQLite keeps its single-writer lock. The gate retries a claim the database aborts as a lock conflict, then parks the run on its retry timer instead of stranding it.
