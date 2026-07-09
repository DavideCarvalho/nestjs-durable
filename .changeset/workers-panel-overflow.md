---
'@dudousxd/nestjs-durable-dashboard': patch
---

Fix the Workers panel's "pods" view overflowing its fixed-width header slot and painting over the pods/parts/alerts toggle. With several live pods, the right-justified `flex-nowrap` row of chips (which must keep `overflow: visible` for the per-pod expand popover) grew far past the 300px slot and spilled left over the toggle. The row now caps to a couple of narrower chips and collapses the rest into a `+N` chip (full instanceIds in its tooltip), so it can never exceed the slot regardless of pod count.
