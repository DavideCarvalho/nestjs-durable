"""Worker/control-plane handshake descriptor + capability negotiation (design §7).

The cross-ecosystem interop contract: a Python worker advertises a :class:`WorkerDescriptor` that is
**byte-identical in shape** to the adonis (``@adonis-agora/durable``) and nestjs (aviary) SDKs, and
its :func:`descriptor_hash` reproduces the SAME 16-char hex ETag those SDKs compute. Pure data + a
deterministic, order-insensitive content hash; NO transport, NO I/O.

CROSS-SDK CONTRACT — every field, the canonical hashing projection and the FNV-1a-64 algorithm here
MUST stay byte-identical to ``packages/core/src/handshake/descriptor.ts`` (nestjs) and the adonis
``src/handshake/descriptor.ts``. The golden fixtures in ``<repo>/fixtures/wire/`` pin the exact bytes
all three SDKs test against; the descriptor fixture hashes to ``44c6793c8eb7089f`` in every SDK.

A Python worker is primarily an *execution* worker, so it mainly ADVERTISES its descriptor (see
``redis_runner._advertise_descriptor``). :func:`negotiate` / :func:`resolve_routing` are provided for
symmetry + local tests, but the read/negotiate side is usually the control-plane's job.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple, Union

Runtime = Literal["node", "python"]
WorkerLifecycle = Literal["up", "draining", "quiescing", "stopped"]

# The current wire-protocol major. The whole protocol as it exists today is defined as v1; the
# handshake exists so a future v2 breaking change is DETECTABLE rather than silently corrupting.
CURRENT_PROTOCOL_VERSION = 1

# The protocol band assumed for a descriptor that omits ``protocol`` entirely — a pre-handshake
# worker. Absence = legacy v1 baseline, assume compatible (design §7.7).
LEGACY_V1_PROTOCOL: Dict[str, Any] = {"version": 1, "range": [1, 1]}

# The feature set a legacy (pre-handshake) worker is assumed to advertise when its ``capabilities``
# field is ABSENT — the ACTUAL aviary durable v1 execution surface. This is the canonical
# "what a v1 worker can do" baseline and MUST stay byte-identical across the adonis + nestjs + python
# SDKs. ``search-attr-v2`` is a MODERN capability layered on top and is deliberately NOT in the v1
# baseline (a v1 worker only guarantees the v1 ``search-attributes`` surface).
LEGACY_V1_CAPABILITIES: Tuple[str, ...] = (
    "saga",
    "signals",
    "search-attributes",
    "priority",
    "entities",
    "child-workflows",
    "singleton",
    "schedules",
    "continue-as-new",
    "queries",
    "cancellation",
)


@dataclass
class WorkerDescriptor:
    """A worker's (or control-plane's) advertised identity, wire-protocol support, feature
    capabilities and registered handlers (design §7.1). Published on startup + on change and consumed
    by :func:`negotiate` and the capability-aware router. Exactly the §7.1 shape."""

    instance_id: str
    runtime: Runtime
    sdk: Dict[str, str]
    protocol: Dict[str, Any]
    capabilities: List[str] = field(default_factory=list)
    workflows: List[str] = field(default_factory=list)
    steps: List[str] = field(default_factory=list)
    started_at: int = 0
    partition: Optional[str] = None
    namespace: Optional[str] = None

    def to_wire(self) -> Dict[str, Any]:
        """Serialize to the wire JSON shape (camelCase keys, in the §7.1 field order). Optional
        ``partition``/``namespace`` are omitted when unset — matching the TS SDK, which only includes
        a present optional field (so a modern-with-partition and legacy-without agree)."""
        wire: Dict[str, Any] = {
            "instanceId": self.instance_id,
            "runtime": self.runtime,
            "sdk": {"name": self.sdk["name"], "version": self.sdk["version"]},
            "protocol": {
                "version": self.protocol["version"],
                "range": [self.protocol["range"][0], self.protocol["range"][1]],
            },
            "capabilities": list(self.capabilities),
            "workflows": list(self.workflows),
            "steps": list(self.steps),
        }
        if self.partition is not None:
            wire["partition"] = self.partition
        if self.namespace is not None:
            wire["namespace"] = self.namespace
        wire["startedAt"] = self.started_at
        return wire

    @classmethod
    def from_wire(cls, raw: Dict[str, Any]) -> "WorkerDescriptor":
        """Parse a (possibly partial/legacy) wire descriptor, filling legacy-v1 defaults — the mirror
        of the TS ``normalizeDescriptor``. An ABSENT ``protocol``/``capabilities`` means legacy v1; an
        explicit empty ``capabilities`` list is a modern SDK that advertises nothing (preserved)."""
        return cls(
            instance_id=raw["instanceId"],
            runtime=raw["runtime"],
            sdk=raw.get("sdk") or {"name": "unknown", "version": "0"},
            protocol=raw.get("protocol") or {"version": 1, "range": [1, 1]},
            capabilities=(
                list(raw["capabilities"])
                if raw.get("capabilities") is not None
                else list(LEGACY_V1_CAPABILITIES)
            ),
            workflows=list(raw.get("workflows") or []),
            steps=list(raw.get("steps") or []),
            partition=raw.get("partition"),
            namespace=raw.get("namespace"),
            started_at=raw.get("startedAt") or 0,
        )


def is_legacy_descriptor(raw: Dict[str, Any]) -> bool:
    """True when a raw wire descriptor predates the handshake — it carries no ``protocol`` field.
    Such a descriptor is treated as legacy v1 and assumed compatible (design §7.7)."""
    return raw.get("protocol") is None


def _canonicalize_for_hash(d: WorkerDescriptor) -> Dict[str, Any]:
    """Canonical, order-insensitive projection used for hashing — byte-identical to the TS
    ``canonicalizeForHash``. The three set-valued fields are sorted + de-duplicated so member order
    can never change the hash; optional fields collapse to ``None`` (JSON ``null``) so
    present-with-``None`` and absent agree. Keys are emitted in a FIXED order."""

    def as_set(xs: Sequence[str]) -> List[str]:
        return sorted(set(xs))

    return {
        "instanceId": d.instance_id,
        "runtime": d.runtime,
        "sdk": {"name": d.sdk["name"], "version": d.sdk["version"]},
        "protocol": {
            "version": d.protocol["version"],
            "range": [d.protocol["range"][0], d.protocol["range"][1]],
        },
        "capabilities": as_set(d.capabilities),
        "workflows": as_set(d.workflows),
        "steps": as_set(d.steps),
        "partition": d.partition,
        "namespace": d.namespace,
        "startedAt": d.started_at,
    }


def _fnv1a64_hex(text: str) -> str:
    """Deterministic 64-bit FNV-1a hash of a string → 16-char lowercase hex. Byte-identical to the TS
    ``fnv1a64Hex``: it folds EACH UTF-16 code unit's low byte then high byte before the multiply, so a
    non-ASCII (or astral) character contributes exactly as ``String.charCodeAt`` would. We iterate the
    string's UTF-16-LE encoding two bytes at a time to reproduce the JS UTF-16 code-unit sequence."""
    offset = 0xCBF29CE484222325
    prime = 0x100000001B3
    mask = 0xFFFFFFFFFFFFFFFF
    h = offset
    units = text.encode("utf-16-le")  # each code unit = 2 LE bytes; astral chars → surrogate pair
    for i in range(0, len(units), 2):
        h ^= units[i]  # low byte  (charCodeAt & 0xff)
        h ^= units[i + 1]  # high byte ((charCodeAt >> 8) & 0xff)
        h = (h * prime) & mask
    return format(h, "016x")


def descriptor_hash(descriptor: Union[WorkerDescriptor, Dict[str, Any]]) -> str:
    """Stable ETag over a descriptor's content (design §7.2) — the SAME 16-char hex the adonis + nestjs
    SDKs compute. Order-insensitive over the set-valued fields and stable across key insertion order.
    Accepts a :class:`WorkerDescriptor` or a raw wire dict (normalized first, so a legacy descriptor
    hashes as its v1 baseline)."""
    d = descriptor if isinstance(descriptor, WorkerDescriptor) else WorkerDescriptor.from_wire(descriptor)
    canonical = _canonicalize_for_hash(d)
    # Compact separators (no spaces) + ensure_ascii=False → the exact string TS ``JSON.stringify``
    # produces for the same canonical object.
    text = json.dumps(canonical, separators=(",", ":"), ensure_ascii=False)
    return _fnv1a64_hex(text)


def heartbeat_status(
    descriptor: Union[WorkerDescriptor, Dict[str, Any]],
    *,
    ts: Optional[int] = None,
    status: WorkerLifecycle = "up",
) -> Dict[str, Any]:
    """Build the compact two-tier heartbeat ``{ts, status, descriptorHash}`` (design §7.2), stamping
    the ETag. ``ts`` defaults to now (epoch ms). The ``descriptorHash`` is what lets the control-plane
    re-read the full descriptor only when it changes."""
    import time

    return {
        "ts": ts if ts is not None else int(time.time() * 1000),
        "status": status,
        "descriptorHash": descriptor_hash(descriptor),
    }


# ---------------------------------------------------------------------------------------------------
# Negotiation (design §7.3/§7.4) — provided for symmetry + local tests. On a Python execution worker
# the control-plane is normally the side that reads + negotiates; a worker mainly advertises.
# ---------------------------------------------------------------------------------------------------

NegotiationOutcome = Literal["compatible", "degraded", "incompatible"]


def _ranges_overlap(a: Sequence[int], b: Sequence[int]) -> bool:
    return max(a[0], b[0]) <= min(a[1], b[1])


def _difference(a: Sequence[str], b: Sequence[str]) -> List[str]:
    bset = set(b)
    return sorted(x for x in set(a) if x not in bset)


def _intersection(a: Sequence[str], b: Sequence[str]) -> List[str]:
    bset = set(b)
    return sorted(x for x in set(a) if x in bset)


def negotiate(
    local_raw: Union[WorkerDescriptor, Dict[str, Any]],
    remote_raw: Union[WorkerDescriptor, Dict[str, Any]],
    *,
    required: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Negotiate compatibility between ``local`` and ``remote`` (design §7.3/§7.4). Mirrors the TS
    ``negotiate`` outcome logic exactly:

    1. no protocol-range overlap → ``incompatible`` (``protocol.incompatible``);
    2. else a ``required`` capability missing on the remote → ``degraded`` (``capability.unavailable``);
    3. else any capability asymmetry (either direction) → ``degraded``;
    4. else full parity → ``compatible``.

    A legacy peer (missing ``protocol``/``capabilities``) normalizes to the v1 baseline first, so it
    negotiates as assume-compatible v1 (design §7.7)."""
    local = local_raw if isinstance(local_raw, WorkerDescriptor) else WorkerDescriptor.from_wire(local_raw)
    remote = remote_raw if isinstance(remote_raw, WorkerDescriptor) else WorkerDescriptor.from_wire(remote_raw)
    local_range = list(local.protocol["range"])
    remote_range = list(remote.protocol["range"])

    shared = _intersection(local.capabilities, remote.capabilities)
    missing_on_remote = _difference(local.capabilities, remote.capabilities)
    missing_on_local = _difference(remote.capabilities, local.capabilities)
    capabilities = {
        "shared": shared,
        "missingOnRemote": missing_on_remote,
        "missingOnLocal": missing_on_local,
    }
    protocol = {"localRange": local_range, "remoteRange": remote_range}

    # (1) Protocol range gap → incompatible. The ONLY path that blocks dispatch outright.
    if not _ranges_overlap(local_range, remote_range):
        return {
            "outcome": "incompatible",
            "negotiatedProtocol": None,
            "protocol": protocol,
            "capabilities": capabilities,
            "reason": {
                "code": "protocol.incompatible",
                "message": (
                    f"no common protocol major: local speaks [{local_range[0]}, {local_range[1]}], "
                    f"remote speaks [{remote_range[0]}, {remote_range[1]}]"
                ),
                "detail": {"localRange": local_range, "remoteRange": remote_range},
            },
        }

    negotiated_protocol = min(local_range[1], remote_range[1])

    # (2) A required capability the remote cannot provide → degraded (router parks the specific run).
    missing_required = _difference(list(required or []), remote.capabilities)
    if missing_required:
        return {
            "outcome": "degraded",
            "negotiatedProtocol": negotiated_protocol,
            "protocol": protocol,
            "capabilities": capabilities,
            "reason": {
                "code": "capability.unavailable",
                "message": "remote is missing required capability(ies): " + ", ".join(missing_required),
                "detail": {
                    "missingRequired": missing_required,
                    "missingOnRemote": missing_on_remote,
                    "missingOnLocal": missing_on_local,
                },
            },
        }

    # (3) Any capability asymmetry → degraded (soft; route capability-requiring work carefully).
    if missing_on_remote or missing_on_local:
        parts: List[str] = []
        if missing_on_remote:
            parts.append("remote lacks " + ", ".join(missing_on_remote))
        if missing_on_local:
            parts.append("local lacks " + ", ".join(missing_on_local))
        return {
            "outcome": "degraded",
            "negotiatedProtocol": negotiated_protocol,
            "protocol": protocol,
            "capabilities": capabilities,
            "reason": {
                "code": "capability.unavailable",
                "message": "capability mismatch: " + "; ".join(parts),
                "detail": {"missingOnRemote": missing_on_remote, "missingOnLocal": missing_on_local},
            },
        }

    # (4) Ranges overlap + full capability parity → compatible.
    return {
        "outcome": "compatible",
        "negotiatedProtocol": negotiated_protocol,
        "protocol": protocol,
        "capabilities": capabilities,
    }


def required_capabilities(handler: Union[Sequence[str], Dict[str, Any]]) -> List[str]:
    """Normalize a handler's capability demand — a bare list or ``{"requires": [...]}`` — to a
    de-duplicated list. An absent/empty list means "runs anywhere" (design §7.5)."""
    if isinstance(handler, dict):
        listed = handler.get("requires") or []
    else:
        listed = list(handler)
    seen: Dict[str, None] = {}
    for cap in listed:
        seen.setdefault(cap, None)
    return list(seen.keys())


def can_route(
    handler: Union[Sequence[str], Dict[str, Any]],
    worker: Union[WorkerDescriptor, Dict[str, Any]],
) -> bool:
    """True iff ``worker`` advertises EVERY capability the handler requires (design §7.5). A legacy
    worker normalizes to the v1 baseline first, so it can still run baseline-only work."""
    required = required_capabilities(handler)
    if not required:
        return True
    w = worker if isinstance(worker, WorkerDescriptor) else WorkerDescriptor.from_wire(worker)
    advertised = set(w.capabilities)
    return all(cap in advertised for cap in required)


def resolve_routing(
    handler: Union[Sequence[str], Dict[str, Any]],
    workers: Sequence[Union[WorkerDescriptor, Dict[str, Any]]],
) -> Dict[str, Any]:
    """Decide whether a handler can be dispatched to the given live fleet (design §7.5). Returns
    ``{"status": "routable", ...}`` with the capable subset, or ``{"status": "blocked", "reason": ...}``
    with the exact dashboard copy when nobody can run it — so the run parks visibly instead of hanging
    silently. An empty fleet always blocks."""
    requires = required_capabilities(handler)
    capable = [w for w in workers if can_route(handler, w)]
    if capable:
        normalized = [
            w if isinstance(w, WorkerDescriptor) else WorkerDescriptor.from_wire(w) for w in capable
        ]
        return {"status": "routable", "workers": normalized, "requires": requires}
    suffix = f" (requires {', '.join(requires)})" if requires else ""
    return {"status": "blocked", "reason": f"blocked: no compatible worker{suffix}", "requires": requires}
