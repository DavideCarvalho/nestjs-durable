---
"@dudousxd/nestjs-durable-core": patch
"@dudousxd/nestjs-durable-testing": patch
"@dudousxd/nestjs-durable-store-mikro-orm": patch
"@dudousxd/nestjs-durable-store-typeorm": patch
"@dudousxd/nestjs-durable-store-prisma": patch
"@dudousxd/nestjs-durable-store-drizzle": patch
---

A turn no longer reads the input of every step its run completed. The replay snapshot is read
through the new optional `StateStore.listCheckpointsForReplay`, which returns `listCheckpoints`'
rows without the input of a completed step, left out of the query itself; a pending or failed step
keeps it, for its re-dispatch or retry. Every bundled store implements it and `CodecStateStore`
decodes what it returns; a custom store without it gets `listCheckpoints`. The check a turn makes
after suspending on a step, whether that step already settled, is now a `COUNT` where the store has
`countCheckpoints`, so it no longer reads the step's input either. In a conversation of 100 KB-input
steps, a resume at turn 20 read about 2.1 MB of checkpoints and now reads about 0.1 MB, whatever the
turn. The run detail, `engine.listCheckpoints`, retry and re-dispatch still read every input.
