"""Cross-SDK handshake conformance (design §7.8).

These golden fixtures are the polyglot wire contract: the adonis, nestjs and python durable SDKs each
serialize to and parse from the SAME bytes in ``<repo>/fixtures/wire/``. Here the Python side asserts
it round-trips them byte-identically, that :func:`descriptor_hash` reproduces the value the TS SDKs
compute (``44c6793c8eb7089f``), and that the negotiate/routing logic mirrors the TS behaviour.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from durable_worker.handshake import (
    CURRENT_PROTOCOL_VERSION,
    LEGACY_V1_CAPABILITIES,
    WorkerDescriptor,
    can_route,
    descriptor_hash,
    heartbeat_status,
    is_legacy_descriptor,
    negotiate,
    required_capabilities,
    resolve_routing,
)

# clients/python/tests/ → repo root is three levels up; fixtures/wire/ is the shared location the
# adonis + nestjs conformance tests also read.
WIRE_DIR = Path(__file__).resolve().parents[3] / "fixtures" / "wire"

# The golden hash pinned by the design spec + Appendix B — identical across TS/Python/Adonis.
GOLDEN_DESCRIPTOR_HASH = "44c6793c8eb7089f"


def _read_raw(name: str) -> str:
    return (WIRE_DIR / name).read_text(encoding="utf8")


def _make_descriptor(**overrides) -> WorkerDescriptor:
    base = dict(
        instance_id="ts-a-1",
        runtime="node",
        sdk={"name": "@adonis-agora/durable", "version": "1.0.0"},
        protocol={"version": 1, "range": [1, 1]},
        capabilities=["saga", "signals"],
        workflows=["CheckoutWorkflow"],
        steps=["Billing.charge"],
        started_at=1000,
    )
    base.update(overrides)
    return WorkerDescriptor(**base)


# --------------------------------------------------------------------------------------------------
# Golden fixture conformance
# --------------------------------------------------------------------------------------------------


def test_descriptor_fixture_parses():
    parsed = json.loads(_read_raw("descriptor.json"))
    d = WorkerDescriptor.from_wire(parsed)
    assert d.instance_id == "ts-billing-01-4821"
    assert d.runtime == "node"
    assert d.protocol == {"version": 1, "range": [1, 1]}
    assert "search-attr-v2" in d.capabilities
    assert d.workflows == ["CheckoutWorkflow", "RefundWorkflow"]


def test_descriptor_fixture_hashes_to_golden():
    parsed = json.loads(_read_raw("descriptor.json"))
    assert descriptor_hash(parsed) == GOLDEN_DESCRIPTOR_HASH
    # And via the typed object → identical.
    assert descriptor_hash(WorkerDescriptor.from_wire(parsed)) == GOLDEN_DESCRIPTOR_HASH


def test_descriptor_round_trips_byte_identically():
    raw = _read_raw("descriptor.json")
    parsed = json.loads(raw)
    # parse → typed → to_wire → serialize must reproduce the exact bytes.
    reserialized = json.dumps(WorkerDescriptor.from_wire(parsed).to_wire(), indent=2) + "\n"
    assert reserialized == raw


def test_heartbeat_fixture_parses_and_etag_matches():
    raw = _read_raw("heartbeat-status.json")
    hb = json.loads(raw)
    assert hb["status"] == "up"
    assert hb["ts"] == 1752710460000
    assert len(hb["descriptorHash"]) == 16
    # Byte-identical round-trip.
    assert json.dumps(hb, indent=2) + "\n" == raw
    # The ETag equals the descriptor fixture's computed hash (the two-tier contract).
    descriptor = json.loads(_read_raw("descriptor.json"))
    assert hb["descriptorHash"] == descriptor_hash(descriptor) == GOLDEN_DESCRIPTOR_HASH


def test_heartbeat_status_builder_stamps_etag():
    parsed = json.loads(_read_raw("descriptor.json"))
    hb = heartbeat_status(parsed, ts=1752710460000)
    assert hb == {"ts": 1752710460000, "status": "up", "descriptorHash": GOLDEN_DESCRIPTOR_HASH}


# --------------------------------------------------------------------------------------------------
# descriptorHash — stability + sensitivity (mutation proofs)
# --------------------------------------------------------------------------------------------------


def test_hash_is_order_insensitive_over_sets():
    a = _make_descriptor(
        capabilities=["saga", "signals", "priority"], workflows=["A", "B", "C"], steps=["x", "y"]
    )
    b = _make_descriptor(
        capabilities=["priority", "saga", "signals"], workflows=["C", "A", "B"], steps=["y", "x"]
    )
    assert descriptor_hash(a) == descriptor_hash(b)


def test_hash_dedups_set_members():
    base = _make_descriptor(capabilities=["saga", "signals"])
    dup = _make_descriptor(capabilities=["saga", "signals", "saga"])
    assert descriptor_hash(dup) == descriptor_hash(base)


@pytest.mark.parametrize(
    "overrides",
    [
        {"capabilities": ["saga", "signals", "priority"]},
        {"workflows": ["Other"]},
        {"steps": ["Billing.refund"]},
        {"started_at": 2000},
        {"protocol": {"version": 2, "range": [1, 2]}},
        {"partition": "p1"},
        {"namespace": "n1"},
    ],
)
def test_hash_changes_when_any_content_field_changes(overrides):
    assert descriptor_hash(_make_descriptor(**overrides)) != descriptor_hash(_make_descriptor())


def test_hash_is_16_char_lowercase_hex():
    import re

    assert re.fullmatch(r"[0-9a-f]{16}", descriptor_hash(_make_descriptor()))


# --------------------------------------------------------------------------------------------------
# Legacy backward-compat (design §7.7)
# --------------------------------------------------------------------------------------------------


def test_legacy_descriptor_defaults():
    raw = {"instanceId": "legacy-1", "runtime": "python"}
    assert is_legacy_descriptor(raw) is True
    d = WorkerDescriptor.from_wire(raw)
    assert d.protocol == {"version": 1, "range": [1, 1]}
    assert d.capabilities == list(LEGACY_V1_CAPABILITIES)
    assert d.workflows == [] and d.steps == []
    assert d.sdk == {"name": "unknown", "version": "0"}
    assert d.started_at == 0


def test_explicit_empty_capabilities_is_preserved():
    raw = {
        "instanceId": "modern-1",
        "runtime": "node",
        "protocol": {"version": 1, "range": [1, 1]},
        "capabilities": [],
    }
    assert is_legacy_descriptor(raw) is False
    assert WorkerDescriptor.from_wire(raw).capabilities == []


def test_legacy_v1_capabilities_is_the_canonical_baseline():
    # Cross-SDK contract: this MUST equal the adonis + nestjs LEGACY_V1_CAPABILITIES byte-for-byte.
    assert list(LEGACY_V1_CAPABILITIES) == [
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
    ]
    assert CURRENT_PROTOCOL_VERSION == 1


# --------------------------------------------------------------------------------------------------
# negotiate — three outcomes (design §7.4)
# --------------------------------------------------------------------------------------------------


def test_negotiate_compatible():
    r = negotiate(_make_descriptor(), _make_descriptor())
    assert r["outcome"] == "compatible"
    assert "reason" not in r
    assert r["negotiatedProtocol"] == 1
    assert r["capabilities"]["shared"] == ["saga", "signals"]


def test_negotiate_degraded_remote_lacks_optional():
    local = _make_descriptor(capabilities=["saga", "signals", "priority"])
    remote = _make_descriptor(capabilities=["saga", "signals"])
    r = negotiate(local, remote)
    assert r["outcome"] == "degraded"
    assert r["reason"]["code"] == "capability.unavailable"
    assert r["capabilities"]["missingOnRemote"] == ["priority"]


def test_negotiate_degraded_required_missing():
    r = negotiate(_make_descriptor(), _make_descriptor(), required=["search-attr-v2"])
    assert r["outcome"] == "degraded"
    assert r["reason"]["detail"]["missingRequired"] == ["search-attr-v2"]


def test_negotiate_required_on_both_stays_compatible():
    both = _make_descriptor(capabilities=["saga", "signals", "search-attr-v2"])
    assert negotiate(both, both, required=["search-attr-v2"])["outcome"] == "compatible"


def test_negotiate_incompatible_no_protocol_overlap():
    local = _make_descriptor(protocol={"version": 1, "range": [1, 1]})
    remote = _make_descriptor(protocol={"version": 2, "range": [2, 2]})
    r = negotiate(local, remote)
    assert r["outcome"] == "incompatible"
    assert r["negotiatedProtocol"] is None
    assert r["reason"]["code"] == "protocol.incompatible"
    assert r["reason"]["detail"]["localRange"] == [1, 1]
    assert r["reason"]["detail"]["remoteRange"] == [2, 2]


def test_negotiate_protocol_takes_precedence_over_capabilities():
    local = _make_descriptor(protocol={"version": 1, "range": [1, 1]}, capabilities=["saga"])
    remote = _make_descriptor(protocol={"version": 3, "range": [3, 3]}, capabilities=["saga"])
    assert negotiate(local, remote)["outcome"] == "incompatible"


def test_negotiate_highest_common_major():
    local = _make_descriptor(protocol={"version": 2, "range": [1, 2]})
    remote = _make_descriptor(protocol={"version": 3, "range": [1, 3]})
    r = negotiate(local, remote)
    assert r["outcome"] == "compatible"
    assert r["negotiatedProtocol"] == 2


def test_negotiate_symmetry_of_delta():
    a = _make_descriptor(capabilities=["saga", "signals", "priority"])
    b = _make_descriptor(capabilities=["saga", "signals"])
    ab = negotiate(a, b)
    ba = negotiate(b, a)
    assert ab["outcome"] == ba["outcome"] == "degraded"
    assert ab["capabilities"]["missingOnRemote"] == ba["capabilities"]["missingOnLocal"]
    assert ab["capabilities"]["missingOnLocal"] == ba["capabilities"]["missingOnRemote"]


def test_negotiate_legacy_peers_compatible():
    r = negotiate({"instanceId": "a", "runtime": "node"}, {"instanceId": "b", "runtime": "python"})
    assert r["outcome"] == "compatible"


# --------------------------------------------------------------------------------------------------
# Capability routing (design §7.5)
# --------------------------------------------------------------------------------------------------


def test_required_capabilities_normalization():
    assert required_capabilities(["saga", "saga", "signals"]) == ["saga", "signals"]
    assert required_capabilities({"requires": ["priority"]}) == ["priority"]
    assert required_capabilities({}) == []


def test_can_route():
    worker = _make_descriptor(capabilities=["saga", "signals", "priority"])
    assert can_route(["saga", "priority"], worker) is True
    assert can_route(["search-attr-v2"], worker) is False
    assert can_route([], worker) is True


# --------------------------------------------------------------------------------------------------
# Worker-loop advertisement wiring (design §7.2) — the descriptor a Python execution worker emits.
# --------------------------------------------------------------------------------------------------


def test_build_descriptor_shape():
    from durable_worker import Worker
    from durable_worker.redis_runner import _INSTANCE_ID, _build_descriptor

    worker = Worker(auto_register=False)

    @worker.step("Billing.charge")
    def _charge(_data):
        return None

    @worker.workflow("CheckoutWorkflow")
    def _checkout(_ctx):
        return None

    d = _build_descriptor(worker, partition="billing", namespace="acme")
    assert d.runtime == "python"
    assert d.instance_id == _INSTANCE_ID
    assert d.instance_id.startswith("py-")
    assert d.sdk["name"] == "durable-worker"
    assert d.protocol == {"version": 1, "range": [1, 1]}
    assert d.workflows == ["CheckoutWorkflow"]
    assert d.steps == ["Billing.charge"]
    assert d.partition == "billing"
    assert d.namespace == "acme"
    assert list(d.capabilities) == list(LEGACY_V1_CAPABILITIES)
    # A default namespace collapses to None (matches the un-namespaced wire shape).
    assert _build_descriptor(worker, partition=None, namespace="default").namespace is None


def test_heartbeat_value_carries_descriptor_etag():
    from durable_worker.redis_runner import _heartbeat_value

    beat_no_hash = json.loads(_heartbeat_value(None))
    assert "descriptorHash" not in beat_no_hash

    beat = json.loads(_heartbeat_value(None, GOLDEN_DESCRIPTOR_HASH))
    assert beat["descriptorHash"] == GOLDEN_DESCRIPTOR_HASH
    assert "ts" in beat


def test_resolve_routing_routable_and_blocked():
    capable = _make_descriptor(instance_id="w1", capabilities=["saga", "search-attr-v2"])
    incapable = _make_descriptor(instance_id="w2", capabilities=["saga"])

    routable = resolve_routing(["search-attr-v2"], [capable, incapable])
    assert routable["status"] == "routable"
    assert [w.instance_id for w in routable["workers"]] == ["w1"]

    blocked = resolve_routing(["search-attr-v2"], [incapable])
    assert blocked["status"] == "blocked"
    assert blocked["reason"] == "blocked: no compatible worker (requires search-attr-v2)"

    # Empty fleet always blocks.
    assert resolve_routing(["saga"], [])["status"] == "blocked"
