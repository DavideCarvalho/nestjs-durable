---
"@dudousxd/nestjs-durable-core": minor
---

`engine.registerStartOnly(name, version, opts?)` lets a process start runs of a workflow it never runs, such as an API pod whose workers register the body. The run is stored and left for an instance that registered the workflow; a start-only instance that picks it up anyway hands it back without logging.

```ts
apiEngine.registerStartOnly('send-invoice', '1');
await apiEngine.start('send-invoice', { id }, `invoice:${id}`); // a worker runs it
```
