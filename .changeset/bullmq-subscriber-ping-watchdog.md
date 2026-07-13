---
'@dudousxd/nestjs-durable-transport-bullmq': minor
---

Fix a permanent hang: `BullMQTransport`'s pub/sub subscriber connections (`onControl`,
`onHeartbeat`, `onRunReply`, `onTenantEvent`) never write on their own, so when a VPN/NAT/idle
timeout silently drops the underlying TCP connection, the server-side subscription is gone
(`PUBSUB NUMSUB` shows 0) while ioredis's client-side socket still believes it's connected — no
write ever fails, no timeout ever fires, and the connection sits half-open forever. Every control
plane call (`listRuns`, cancel, etc.) then blocks until the process restarts.

Adds a shared ping watchdog: every `pingIntervalMs` (new option, default `30_000`; pass `0` or
`false` to disable), each subscriber connection this transport owns gets a `PING` (legal in
subscriber mode). A rejection or timeout `disconnect(true)`s that connection, letting ioredis's own
`retryStrategy` reconnect and `autoResubscribe` restore its channel — logging once on detection and
once on successful resubscribe. Also attaches a de-duplicated `error` listener to every subscriber
connection (an unhandled `error` event on an ioredis instance crashes the process in some setups),
and applies a TCP keepalive floor to connections the transport builds itself as a secondary defence.
The watchdog is a single shared interval (not one per connection) and is torn down in `close()`.

Regression-tested against a real Redis (`bullmq-transport.db.spec.ts`) using a silent TCP relay that
severs the server-side leg of a subscriber connection while leaving the client socket open and
unresponsive — the same failure mode `CLIENT KILL` doesn't reproduce, since ordinary FIN/RST
disconnects already recover via ioredis's own handling. Verified: without the watchdog the test
times out; with it, `PUBSUB NUMSUB` recovers and a dispatched `RunReply` is delivered within ~500ms.
