---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
---

Event **debounce** and **batch** for `onEvent` triggers — coalesce a burst of events into fewer runs (Inngest-style).

- `@Workflow({ onEvent: ['x'], debounce: '30s' })` — start one run with the LAST payload once events have been quiet for the window (resets on each event).
- `@Workflow({ onEvent: ['x'], batch: { maxSize: 100, within: '10s' } })` — start one run with all payloads (`{ events: [...] }`) once `maxSize` is reached or `within` elapses from the first event.
- Engine: `register(..., { eventBatch })`. Built on the new signal buffering + `signalWithStart` + `continueAsNew` — a per-target accumulator coalesces and then starts the target.

(Queue priority from the same roadmap item is deferred: the poll-based flow-control queue model makes strict priority awkward, and soft priority adds little.)
