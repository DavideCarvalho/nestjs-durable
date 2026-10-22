---
"@dudousxd/nestjs-durable-core": minor
---

`CodecStateStore` takes an optional third argument, `{ coverage: 'payloads' | 'extended' }`.

The default, `'payloads'`, keeps today's behaviour: run and step `input`/`output` (plus schedule input and buffered signal/event payloads) go through the codec, and step `events` and step/run `error` are stored as written. `'extended'` also encodes step `events`, step `error` and run `error`, on every write and read path. Ids, status, tags, search attributes and other queryable metadata stay clear in both modes, and a patch with `error: undefined` still clears the error.

Only enable `'extended'` on a fresh table, or with a codec whose `decode` passes through values it didn't encode: rows written before the switch hold those fields as plaintext.
