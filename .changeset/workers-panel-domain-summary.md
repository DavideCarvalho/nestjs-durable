---
'@dudousxd/nestjs-durable-dashboard': patch
---

Workers panel: summarise in domain terms + styled tooltips + a clickable overflow.

- **"N workflows · M steps"** replaces the raw "76 queues" in the alerts summary — deduped by base name across partitions, driven by the new `GroupHealth.kind` from the control plane. A hover tooltip explains route-by-handler and still shows the underlying queue count.
- **Styled tooltips** replace the browser's native `title=` bubble on the pod, partition, starved, and summary chips — same dark surface as the panel's popovers, positioned below-right so they never clip the header edge, and suppressed while a chip's own click-popover is open.
- **The "+N" overflow chip is now clickable**: it opens a popover listing exactly which pods it hides (instanceId · partition · handler count · load), instead of hiding them behind an unreadable multi-line `title`.
