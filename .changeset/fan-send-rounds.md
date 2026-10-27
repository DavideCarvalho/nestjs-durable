---
'@dudousxd/nestjs-durable-core': patch
---

A wide step fan is written and dispatched in rounds of up to 2,000 steps: a round is dispatched as
soon as its checkpoints commit, while the next round is written. Workers start on a 40,000-step fan
after its first round instead of after every checkpoint of it has committed. No result can wake the
run before the whole fan is written (the run stays `running` under the sending turn's lease), and a
send cut short leaves the unwritten steps to the replay, which sends them once the written ones
settle.
