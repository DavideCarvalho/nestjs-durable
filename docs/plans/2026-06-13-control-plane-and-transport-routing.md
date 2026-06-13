# Plan: separate the Control Plane from the Transport + per-step/workflow transport routing

Status: **design only — not implemented.** Captures two decisions made 2026-06-13.

## Why

Two problems with one root cause — the `Transport` is doing two unrelated jobs:

1. **Work dispatch** — point-to-point, durable, at-least-once (`dispatch`/`onResult`/`onHeartbeat`).
2. **Broadcast** — fan-out, best-effort (`publishControl`/`onControl`, added in 0.5.0 for cross-pod
   live-tail + cooperative cancel).

Consequences of the coupling:
- Every new transport must re-implement pub/sub. Today only **BullMQ** (Redis) and the in-process
  transports have it; **SQS and DB degrade to local-only** — no cross-pod live-tail/cancel.
- It blocks **per-workflow / per-step transport routing**: if a run can dispatch different steps to
  different transports, "the transport's control plane" is ambiguous — which one broadcasts?

So: **(A) extract `ControlPlane` as its own abstraction**, and **(B) let the engine hold a registry
of transports and route each step to one**. (A) must land first; (B) depends on it.

---

## Part A — `ControlPlane` as a first-class, separate abstraction

### Interface

```ts
/** Broadcast pub/sub across all engine instances. Independent of the work Transport. */
export interface ControlPlane {
  publish(msg: ControlMessage): Promise<void>;
  /** Returns an unsubscribe fn. Handler receives every message (the engine dedupes by `from`). */
  subscribe(handler: (msg: ControlMessage) => void): () => void;
  close?(): Promise<void>;
}
```

`ControlMessage` (`{ kind: 'event' | 'cancel', from?, ... }`) moves out of the Transport section.

### Implementations (pick per deployment, independent of the transport)

| Impl | Mechanism | Fits |
|------|-----------|------|
| `InMemoryControlPlane` | one `EventEmitter` | single-process / tests |
| `RedisControlPlane` | Redis pub/sub | anyone with Redis (BullMQ users get it free) |
| `PostgresControlPlane` | `LISTEN`/`NOTIFY` | **DB/SQS users with Postgres** — no Redis needed |
| `PollingControlPlane` | a `durable_control` table polled every N ms | MySQL/SQLite, last resort |
| `SnsControlPlane` (later) | SNS fan-out → per-pod SQS | SQS-native AWS shops |
| `WebSocketControlPlane` (later) | a WS hub | cross-pod without Redis; NAT'd workers |

### Engine wiring

```ts
new WorkflowEngine({
  store,
  transport,                 // or `transports` (Part B)
  controlPlane: redisCP,     // optional — omit ⇒ local-only events, no cross-pod
});
```

- `engine.emit()` → deliver locally + `controlPlane?.publish({ kind:'event', ... })`.
- ctor → `controlPlane?.subscribe(...)` re-delivers remote events + cancels (already the 0.5.0 logic,
  just pointed at `controlPlane` instead of `transport`).
- **Default**: if `controlPlane` is omitted and the transport is in-process, default to a shared
  `InMemoryControlPlane`; otherwise local-only. Never auto-open a Redis/PG connection implicitly.

### Migration (breaking, fine at 0.x)

- Remove `publishControl`/`onControl` from `Transport` (added in 0.5.0).
- Move the BullMQ Redis pub/sub impl → a `RedisControlPlane` (in `transport-bullmq` or a new
  `control-redis` package; leaning new package so it's reusable with SQS/DB).
- The in-memory/event-emitter control-plane impls → `InMemoryControlPlane` / its own.
- One minor-version note + codemod-able: `{ transport: bullmq }` → `{ transport: bullmq, controlPlane: new RedisControlPlane(conn) }`.

---

## Part B — per-workflow / per-step transport routing

Today the engine has **one** global transport. Goal: route different steps to different transports
within the same run — e.g. a heavy ML step → an **HTTP** transport (serverless, scales to zero), a
payments step → **BullMQ** (durable), a legacy step → **SQS**.

### Granularities (resolved finest-wins)

1. **Per step** — `remoteStep({ name, group, transport?: string | string[] })`. Most explicit. A
   **list** = ordered preference with failover (below).
2. **Per group** — `group → transport(s)` map on the engine. Natural: a `group` already *is* the
   worker-pool identity, and a pool lives on one broker.
3. **Per workflow** — `@Workflow({ transport })` as the default for its steps.

Resolution order for a step: `step.transport ?? groupTransport[step.group] ?? workflow.transport ?? 'default'`.

### Engine API

```ts
new WorkflowEngine({
  store,
  transports: { default: bullmq, ml: httpTransport, legacy: sqs },
  groupTransport: { payments: 'default', ml: 'ml' },   // optional group→key map
  controlPlane,
});
```

Back-compat: keep accepting `transport` (single) — it becomes `transports.default`.

### Multi-transport failover (an ordered list, not just one)

A step can name an **ordered list** of transports — `transport: ['bullmq', 'sqs', 'http']` — and the
engine fails over down the list. There are **two distinct failure points**, and they have very
different safety:

**1. Dispatch-time failover — always safe, do it.**
If enqueuing on `transports[0]` throws (broker unreachable, connection refused), the task was never
handed to anyone, so the engine just tries `transports[1]`, etc. Record the **transport that
actually accepted it** on the checkpoint (so the result handler + recovery know where it lives). Pure
resilience to one broker being down, zero duplication risk. Optional small backoff between attempts.

**2. Liveness failover — useful, but it's at-least-once, not magic.**
The task was enqueued on A, but no result/heartbeat arrives within the step's `timeoutMs` (worker
dead, queue stuck). The engine re-dispatches — and can **escalate to the next transport** instead of
retrying the same one. The catch:
- The original message is usually **still on queue A** (SQS can't delete by id; BullMQ can, best-effort),
  so a worker on A *may* still run it → **two workers can run the same step**.
- That's tolerable because the engine **already dedupes the result**: `completeRemoteResult` only
  completes a `pending` checkpoint, so the **first result wins and the second is a no-op** (already
  shipped). What it can't dedupe is a **non-idempotent side-effect** — but that's the standing
  at-least-once contract (a normal retry has the same exposure).
- ⇒ **Liveness failover requires `timeoutMs` set and idempotent steps** (the `stepId` is the natural
  idempotency key — already passed to workers). Document it as "escalate on presumed-dead worker",
  not "exactly-once across brokers".

**Optional circuit breaker.** If a transport fails dispatch N times in a row, open its circuit and
skip straight to the next for a cooldown — avoids hammering a dead broker. Adds a little state; nice
later, not required for v1.

**Recovery interaction.** The checkpoint must record which transport(s) a pending remote step was
dispatched to, so `recoverIncomplete` re-dispatches/listens correctly after a crash — it can't assume
a single global transport anymore.

### What stays transport-agnostic (the reason this is tractable)

- **Results**: the engine subscribes `onResult` on **every** registered transport; `completeRemoteResult`
  already finds the checkpoint by `stepId`, so a result from *any* transport completes the run.
- **Recovery / timers**: store-based — they don't touch the transport.
- **Heartbeats**: subscribe `onHeartbeat` on every transport.
- **Control plane**: one global `ControlPlane`, independent of how many transports exist — which is
  exactly why Part A must come first.

### Worker side

Unchanged: each worker registers its `@DurableStep` handlers on the transport it serves (its group's
broker). Routing is an **engine-side dispatch** concern; workers stay single-transport.

### Open questions

- Per-step `transport` string vs a typed handle — stringly-typed keys are simplest but unchecked.
- A step's `timeoutMs` liveness path assumes one transport's heartbeats; fine since a step dispatches
  to exactly one transport.
- Failure isolation: if one transport's broker is down, only its steps stall (others proceed) — and
  with a transport list they **fail over** (see above). `recoverIncomplete` must not assume a single
  transport when re-dispatching, and must read the recorded transport from the checkpoint.

---

## New transports this unlocks

- **HTTP transport** — engine `POST`s the step to a worker (webhook); worker `POST`s the result back
  to an engine callback endpoint. Great for serverless/any-language workers, **zero queue infra**.
  Trade-off: HTTP isn't a persistent queue — if the worker is down at dispatch, there's nowhere to
  wait, so the engine must **retain + retry the dispatch** (worker idempotent by `stepId`, which we
  have). A "lighter, less-durable" transport with that trade-off documented.
- **WebSocket** — best as a **`ControlPlane`** first (native bidirectional broadcast, no Redis). As a
  *work* transport it's niche: workers behind NAT/firewall that connect *out* to the engine.

## Suggested order

1. **Extract `ControlPlane`** (Part A) — fixes the coupling I introduced in 0.5.0; everything else
   builds on it.
2. **`PostgresControlPlane`** (`LISTEN/NOTIFY`) — cross-pod without Redis for DB/SQS users.
3. **Transport registry + routing** (Part B), starting with per-group (the natural unit), then the
   ordered-list **dispatch-time failover** (the safe, high-value half), then **liveness failover**
   (gated on `timeoutMs` + idempotent steps).
4. **HTTP transport** — high demand (serverless), with the durability caveat.
5. **WebSocket control plane** — broadcast without Redis; NAT'd workers later.
