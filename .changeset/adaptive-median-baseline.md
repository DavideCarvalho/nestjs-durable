---
'@dudousxd/durable-worker': patch
---

The adaptive concurrency controller's no-queuing baseline is the window's median latency, smoothed
(it follows a drop at once and a rise slowly), instead of the window's fastest step. In a fleet sharing
one Redis and one database, a step that landed on a quiet moment set the baseline ten times below a
steady p50, so the gradient read the shared latency as this worker's queuing and held workers at one or
two slots: in flip dev, 4 of 6 workers ran a 40,000-step fan at 1–2 slots. A latency that holds now
becomes the baseline within a few ticks, and only a rise past twice the baseline shrinks the limit.

A tick with no settled step no longer moves the limit: the window still holds the last burst, and read
again tick after tick it cut an idle worker's limit to a few slots before the next burst began.

40,000-step fan, six processes, a Redis capped at 0.15 CPU behind 3 ± 15 ms of latency, after a warm-up
fan in the same processes: 61–67 s → 26 s, level with a fixed concurrency of 32. With MySQL's CPU
saturated by the steps it ties the previous controller and fixed 4 and 32. The Python `durable-worker`
0.26.4 makes the same decisions.
