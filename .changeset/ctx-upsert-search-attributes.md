---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/durable-worker": patch
---

Add `ctx.upsertSearchAttributes(attrs)` — set a run's indexed `searchAttributes` from inside the workflow, without injecting the store.

Previously, tagging the run you're executing meant injecting the raw state-store token into a `@Workflow` and calling `store.getRun(ctx.runId)` + `store.updateRun(ctx.runId, { searchAttributes })` — awkward, and it coupled the workflow to store access. Now:

```ts
// before
@Inject(STATE_STORE) private readonly store: StateStore;
const run = await this.store.getRun(ctx.runId);
await this.store.updateRun(ctx.runId, {
  searchAttributes: { ...(run?.searchAttributes ?? {}), key: value },
});

// after — no injection at all
await ctx.upsertSearchAttributes({ key: value });
```

Shallow-merges into the run's `searchAttributes` (keys you don't pass are kept). Durable + **exactly-once**: recorded at its position on the first run and skipped on replay (one write, not one per turn), nondeterminism-guarded like every other ctx primitive — it mirrors `ctx.transaction`'s record-once semantics. On the thin `@dudousxd/durable-worker` (no store) it throws `UnsupportedOnThinWorker` — run such a workflow in-process on the engine.
