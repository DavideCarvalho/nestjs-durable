---
'@dudousxd/nestjs-durable-dashboard': patch
---

Make the pods inside the Workers panel's "+N" overflow popover click-to-expand, exactly like the visible pod chips: clicking a hidden pod's row now reveals the same detail (live status cells + the full list of handlers it serves) inline, instead of showing only its one-line summary. The shared body is factored into a `PodDetail` component so a pod behind "+N" and a visible chip reveal identical detail.
