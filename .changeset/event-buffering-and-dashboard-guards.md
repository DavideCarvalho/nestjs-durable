---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-testing': minor
'@dudousxd/nestjs-durable-store-mikro-orm': minor
'@dudousxd/nestjs-durable-store-drizzle': minor
'@dudousxd/nestjs-durable-store-prisma': minor
'@dudousxd/nestjs-durable-store-typeorm': minor
'@dudousxd/nestjs-durable-dashboard': minor
'@dudousxd/nestjs-durable': patch
---

**Events gain the same lost-wake protection `ad5c510` gave signals.** Before this release,
`engine.publishEvent` silently DROPPED a publish that matched no live `ctx.waitForEvent` waiter, and
`waitForEvent` never consulted any buffer — the same class of bug the prior signal-race fix closed,
just unfixed for events (e.g. a webhook/event source firing before the workflow reached its
`waitForEvent` call would lose that event forever).

Semantics (mirrors `signalWithStart`'s reliability contract for signals, documented on
`engine.publishEvent`):
- A publish that resumes ≥1 live waiter, or routes into an `eventBatch` accumulator / starts ≥1
  `onEvent` subscriber, behaves exactly as before and is NOT buffered — fan-out stays live-only.
- A publish that touches NOBODY buffers ONE copy (`opts.buffer: false` opts out), consumed by the
  FIRST future `waitForEvent(name, { match })` whose match accepts it — point-to-point on redelivery,
  by design, even though the live path above is fan-out. `opts.id` dedupe still applies to subscriber
  starts only.
- Right after buffering, `publishEvent` re-checks for a waiter that registered in the sliver between
  the initial miss and the buffer write (sandwich parity with `signal`'s own take → buffer → recheck);
  `waitForEvent` does the mirror-image check right after registering. UNLIKE `waitForSignal`, an event
  token embeds the call's own `runId#seq` (never reused across iterations the way a signal token can
  be), so there is no entity-loop-reuse hazard from registering before checking — a single
  post-registration scan closes the race.
- New engine option `eventBufferTtlMs` (default unset = keep until consumed, like buffered signals):
  when set, the due-timer reconcile pass prunes expired buffered events for the names it already
  touches during its sweep.

New SPI: `StateStore.bufferEvent`/`listBufferedEvents`/`removeBufferedEvent` (a new
`durable_buffered_events` table, name-keyed with match-based consumption rather than the token-keyed
blind-take `bufferSignal`/`takeBufferedSignal` uses — the match predicate belongs to the WAITER, so
consumption is list + evaluate locally + atomically claim), implemented across every first-party store
(in-memory, MikroORM, Drizzle, Prisma, TypeORM) with a shared conformance case. The remote/polyglot
workflow-command protocol has no `waitEvent` command — events remain reachable only from in-process
`ctx.waitForEvent` and `engine.publishEvent`, not from a remote-executor workflow; extending that
protocol is future work, not invented here.

**`nestjs-durable-dashboard` gains first-class `guards`/`imports` options** on
`DurableDashboardModule.forRoot(...)`, mirroring `@dudousxd/nestjs-agent-dashboard`'s console exactly:
guard classes are stamped onto BOTH the UI (page) controller and the JSON API controller via
`@nestjs/common`'s own `@UseGuards` metadata key (replace, not append, on a repeated `forRoot` call),
and `DurableApiModule` is now a dynamic module so a guard's own dependencies resolve from the host's
`imports` instead of failing to boot with "Nest can't resolve dependencies ... in the DurableApiModule
context". Documents the header-vs-cookie reality for the two mount points: the JSON API is fetched by
the SPA's own JS (a header-based guard works normally), but the UI shell is a full-page browser
navigation with no custom header — only an ambient cookie (or no guard at all) reaches it there.
