---
"@dudousxd/nestjs-durable-dashboard": patch
---

Polish the dashboard: a proper SVG brand mark (a workflow glyph) replaces the bare `◆` in the header and the empty state. The spans waterfall now sizes every bar by the window that matches the rest of the UI — a child-ref step uses the child run's full window (no more 0ms on an awaited child), a fan-out step uses its sub-process span (min start → max end) — and each sub-process row shows its own duration. Bars animate smoothly (CSS width transition) as live durations grow.
