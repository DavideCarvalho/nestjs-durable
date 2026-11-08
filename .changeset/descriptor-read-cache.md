---
'@dudousxd/nestjs-durable-core': patch
'@dudousxd/nestjs-durable-transport-bullmq': patch
---

The routing guard reuses the worker descriptors it read for a queue token for `workerDescriptorCacheMs` (default 2000; `0` reads on every dispatch), with one read in flight per token. On BullMQ every dispatch used to `SCAN` the whole Redis keyspace (68 SCANs per 5-step workflow in the bench, a quarter of Redis time). It still re-reads before parking a run `blocked`, so a worker that just joined is always seen. `BullMQTransport.readWorkerDescriptors` scans in pages of 1000 and reads each page's matches with one `MGET`.
