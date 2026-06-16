---
"@dudousxd/nestjs-durable-dashboard": minor
---

Deep-link the open run and let nested child steps open their detail.

- The open run is now stored in the URL hash (`#/run/<id>`) — reload-safe and shareable; back/forward navigates run history.
- Clicking a step **inside an expanded child sub-flow** (graph node or spans row) now opens its detail panel, rendering from the child run it belongs to (not only the root run's timeline). Selection is keyed by `runId#seq` across lanes.
