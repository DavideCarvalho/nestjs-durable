---
'@dudousxd/nestjs-durable': patch
---

Re-export `RunGateway` as a value, so it works as the DI token it is

`RunGateway` is an abstract class that doubles as its own DI token (`RUN_GATEWAY` is the
deprecated alias pointing at the same class), but the facade block in `index.ts` re-exported it
from `export type { ... }`. The `.d.ts` rollup drops the `type` modifier, so consumers saw a
value export and type-checked green, while the JS bundle correctly omitted it:

```ts
import { RunGateway } from '@dudousxd/nestjs-durable'; // undefined at runtime
moduleRef.get(RunGateway); // Nest could not find given element
```

`tsc`, `tsup` and the test suite were all green — the failure only surfaced on the code path that
resolved the gateway. `RunGateway` now sits in the value re-export next to `WorkflowEngine`, and a
new spec asserts every facade-re-exported core class survives into the bundle.
