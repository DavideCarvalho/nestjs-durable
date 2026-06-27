---
'@dudousxd/nestjs-durable-dashboard': patch
---

Run-detail graph: single-step child runs (e.g. `ctx.gather_children` handler wrappers) now render collapsed as their lone inner step — named directly (`handle_AF_FLEET`), one level, with the inner step's status/duration/sub-counts. No more generic "child workflow" node to expand to reach the handler, and the fan reads as the handlers themselves. The `child ↗` affordance is kept; only the (now pointless) inline-expand chevron is hidden. Visible children are fetched eagerly so the collapse also applies when viewing the parent run with a child expanded.
