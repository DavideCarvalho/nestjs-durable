"""Adaptive concurrency controller + live worker status snapshot.

The Python half of "Observable + Adaptive Workers". It follows the TypeScript controller in
``packages/worker/src/adaptive-concurrency.ts`` — same gradient-limit algorithm, same decision
order, and the same ``WorkerStatus`` JSON shape (camelCase keys) so the engine can aggregate Node
and Python workers uniformly and Telescope/the dashboard render either identically.

Three responsibilities:

* **Observability (both modes).** Wrap the job processor with :meth:`on_start` / :meth:`on_settle`
  so the controller tracks ``inFlight``, a rolling window of completion durations + ok/err, memory
  (vs the cgroup memory ceiling), CPU, throughput and p95. :meth:`snapshot` returns the
  ``WorkerStatus`` dict the heartbeat writer stamps on every beat. A FIXED worker still emits this.

* **Adaptive control (adaptive mode only).** A control loop every ``tickMs`` recomputes a gradient
  (``rttLong``/``rttShort``) and adjusts the limit (ram_ceiling / cpu_ceiling / backpressure /
  shrink / grow / hold), only GROWING when saturated. Standard Vegas/Gradient2 practice.

* **Memory admission control (adaptive mode, on by default).** :meth:`await_admission` is a gate the
  runner awaits BEFORE it starts a step, so a step that would not fit is DEFERRED instead of started
  and OOM-killed. See below.

Stdlib only — ``resource``, ``os``, ``time`` — no new dependencies.

Why a gate, and not just the RAM brake (the 2026-09 OOM incident)
-----------------------------------------------------------------
A worker running ML handlers (one DuckDB panel of a few hundred MB per step) was OOM-killed three
times with ``concurrency="adaptive"``. Three separate reasons, all fixed here:

1. **Peak, not current.** The memory numerator was ``getrusage().ru_maxrss`` — the process
   HIGH-WATER mark, which never decreases. The brake therefore fired late AND, once tripped, stayed
   tripped for the life of the process even after every byte had been freed (the worker latched at
   ``min`` forever). We now read cgroup v2 ``memory.current`` (the number the kernel's OOM killer
   acts on), then cgroup v1 ``memory.usage_in_bytes``, then ``/proc/self/status`` ``VmRSS``, and only
   as a last resort ``ru_maxrss``. Page cache the cgroup is charged for is RECLAIMABLE, so we
   subtract ``memory.stat``'s ``inactive_file`` — the same "working set" kubelet evicts on.
2. **Reacting 20% at a time.** Crossing ``ramCeilingPct`` shrank the limit by ``* 0.8`` per tick; an
   allocation that doubles usage in seconds outruns that. Memory is not a latency signal — it kills
   the process — so the response is now ASYMMETRIC: cross the ceiling and the limit drops to ``min``
   in one move; growing back requires ``growHeadroomTicks`` consecutive ticks with real headroom.
3. **No admission control.** The limit was only a target the loop converged to: nothing asked "is
   there room for one more RIGHT NOW?" before taking the next job. :meth:`try_admit` /
   :meth:`await_admission` answer exactly that, and the Redis runner awaits the gate before it starts
   a step. A deferred job is NOT failed — it waits (its BullMQ lock keeps being renewed) and runs as
   soon as there is headroom, so a gated worker never turns a memory shortage into a failed step.

The gate also reserves the observed cost of the steps already running (learned per step NAME from
runs where a step was the only one in flight), because usage at admission time does not yet include
what an admitted-but-not-yet-allocated step is about to take. For the same reason the FIRST task of a
process runs alone: with zero measurements, N jobs arriving into a fresh pod would all read the same
low usage and all be admitted. That wait is bounded by one settle, not by a timer.

Divergence from the TypeScript controller: the memory numerator, the asymmetric brake, the
``growHeadroomTicks`` gate on growth, the admission gate and the additive ``status.memory`` block are
Python-only for now. ``WorkerStatus`` stays backward compatible (``rssBytes``/``rssPct`` keep their
meaning — they are just measured correctly now, and unknown keys are ignored by TS consumers).

Runtime-settable concurrency on the bullmq python port
------------------------------------------------------
The bullmq python ``Worker`` stores its concurrency in ``worker.opts["concurrency"]`` (there is NO
top-level ``.concurrency`` attribute). Its ``run()`` scheduling loop re-reads
``self.opts.get("concurrency")`` on every iteration, so mutating ``worker.opts["concurrency"]`` IS
honoured live: a higher value lets the loop pull more jobs on the next pass; a lower value stops it
scheduling new jobs past the new ceiling while already-in-flight jobs drain. The runner therefore
applies adjustments via ``bull_worker.opts["concurrency"] = n``. (If a future port version stopped
re-reading opts each pass, the controller would still emit the intended ``limit`` in status so the
dashboard shows the decision even if the port could not apply it live.)
"""

from __future__ import annotations

import asyncio
import math
import os
import resource
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Deque, Dict, Optional, Tuple, Union

# Rolling window of the most recent completions used for latency/throughput/error stats.
_WINDOW_SIZE = 100

# EWMA weight on the OLD rttLong when folding in the window minimum. High (slow) so the "no-queuing"
# baseline reacts fast to a genuinely lower minimum but RESISTS rising when latency inflates under
# queuing — which is exactly what keeps the gradient low (and triggers a shrink) while p50 climbs.
_RTT_LONG_ALPHA = 0.9

# cgroup "unlimited" sentinel: cgroup v1 reports a value near 2**63 when no limit is set; treat any
# absurdly large ceiling (>= 1<<62) as "no limit" and fall through to host total.
_CGROUP_UNLIMITED = 1 << 62

# Defaults for the adaptive config (mirror the TS AdaptiveConcurrency defaults).
_DEFAULT_MIN = 1
_DEFAULT_MAX = 32
_DEFAULT_RAM_CEILING_PCT = 85.0
_DEFAULT_TICK_MS = 2000

# Memory-admission defaults (Python-only — see the module docstring). The admit mark sits BELOW
# ramCeilingPct on purpose: the gate's whole job is to stop starting work before the brake (and the
# kernel) has to act. ``ramResumePct`` is the hysteresis mark — once deferring, usage must fall back
# under it before the gate reopens, so a worker sitting exactly at the mark doesn't flap.
_DEFAULT_RAM_ADMIT_PCT = 75.0
_DEFAULT_RAM_RESUME_PCT = 65.0
_DEFAULT_ADMISSION_POLL_MS = 250
_DEFAULT_ADMISSION_MAX_WAIT_MS = 0  # 0 = wait as long as it takes (pure backpressure)
_DEFAULT_GROW_HEADROOM_TICKS = 3

# How many per-name cost observations to keep. A rolling max over the last few SOLO runs: enough to
# stay conservative, short enough to forget a one-off overestimate instead of throttling forever.
_STEP_COST_SAMPLES = 5

# Where the memory numbers come from. Under Kubernetes with cgroup v2 the container gets its own
# cgroup namespace, so these root paths ARE the container's own files.
_CGROUP_V2_ROOT = "/sys/fs/cgroup"
_CGROUP_V1_MEMORY_ROOT = "/sys/fs/cgroup/memory"
_PROC_SELF_CGROUP = "/proc/self/cgroup"
_PROC_SELF_STATUS = "/proc/self/status"

# Sentinel for "resolve the cgroup v2 directory yourself" (None means "there is no cgroup v2").
_AUTO = "auto"


@dataclass
class ConcurrencyConfig:
    """Normalized concurrency configuration produced by :func:`resolve_concurrency`.

    ``mode`` is ``'fixed'`` or ``'adaptive'``. For a fixed worker ``limit`` is the constant N. For
    an adaptive worker ``limit`` is the START value (clamped into ``[min, max]``).

    Everything from ``ram_admission`` down is the Python-only memory-admission layer. The defaults
    are the safe ones (gate ON for an adaptive worker); ``ram_admission=False`` restores the exact
    pre-0.25 behaviour.
    """

    mode: str
    limit: int
    min: int
    max: int
    ram_ceiling_pct: float
    cpu_ceiling_pct: Optional[float]
    tick_ms: int
    # -- memory admission (adaptive mode only; a fixed worker's limit is the user's explicit promise)
    ram_admission: bool = True
    ram_admit_pct: float = _DEFAULT_RAM_ADMIT_PCT
    ram_resume_pct: float = _DEFAULT_RAM_RESUME_PCT
    admission_poll_ms: int = _DEFAULT_ADMISSION_POLL_MS
    admission_max_wait_ms: int = _DEFAULT_ADMISSION_MAX_WAIT_MS
    grow_headroom_ticks: int = _DEFAULT_GROW_HEADROOM_TICKS
    subtract_page_cache: bool = True
    step_cost_tracking: bool = True


def _coalesce(source: Dict[str, Any], *keys: str) -> Any:
    """First present (camelCase or snake_case) key's value, else None — so a Python caller may pass
    either ``ramCeilingPct`` (contract spelling) or ``ram_ceiling_pct`` (pythonic)."""
    for key in keys:
        if key in source and source[key] is not None:
            return source[key]
    return None


def resolve_concurrency(opt: Union[int, str, Dict[str, Any], None]) -> ConcurrencyConfig:
    """Normalize a ``concurrency`` option into a :class:`ConcurrencyConfig`.

    * ``None`` -> fixed, limit 1 (unchanged default).
    * ``int``  -> fixed, that N.
    * ``'adaptive'`` -> adaptive with all defaults.
    * ``dict`` -> adaptive with overrides (``mode`` is ignored — a dict always means adaptive, per
      the contract ``{ mode: 'adaptive' } & AdaptiveConcurrency``). Keys accepted in camelCase
      (``min``/``max``/``start``/``ramCeilingPct``/``cpuCeilingPct``/``tickMs``) or snake_case.

      Python-only memory-admission keys (same either spelling): ``ramAdmission`` (bool, default
      True), ``ramAdmitPct`` (75), ``ramResumePct`` (65), ``admissionPollMs`` (250),
      ``admissionMaxWaitMs`` (0 = unbounded), ``growHeadroomTicks`` (3), ``subtractPageCache``
      (True), ``stepCostTracking`` (True).
    """
    if opt is None:
        return ConcurrencyConfig("fixed", 1, 1, 1, _DEFAULT_RAM_CEILING_PCT, None, _DEFAULT_TICK_MS)

    if isinstance(opt, bool):
        # bool is an int subclass; a stray True/False is almost certainly a mistake — treat as fixed 1.
        return ConcurrencyConfig("fixed", 1, 1, 1, _DEFAULT_RAM_CEILING_PCT, None, _DEFAULT_TICK_MS)

    if isinstance(opt, int):
        limit = max(1, opt)
        return ConcurrencyConfig("fixed", limit, limit, limit, _DEFAULT_RAM_CEILING_PCT, None, _DEFAULT_TICK_MS)

    if isinstance(opt, str):
        if opt.strip().lower() != "adaptive":
            raise ValueError(f"unknown concurrency option {opt!r}; expected an int, 'adaptive', or a dict")
        opt = {}

    if isinstance(opt, dict):
        minimum = int(_coalesce(opt, "min") or _DEFAULT_MIN)
        maximum = int(_coalesce(opt, "max") or _DEFAULT_MAX)
        if maximum < minimum:
            maximum = minimum
        start_raw = _coalesce(opt, "start")
        start = int(start_raw) if start_raw is not None else minimum
        start = max(minimum, min(maximum, start))
        ram_ceiling = _coalesce(opt, "ramCeilingPct", "ram_ceiling_pct")
        cpu_ceiling = _coalesce(opt, "cpuCeilingPct", "cpu_ceiling_pct")
        tick_ms = _coalesce(opt, "tickMs", "tick_ms")
        ceiling_pct = float(ram_ceiling) if ram_ceiling is not None else _DEFAULT_RAM_CEILING_PCT

        admission = _coalesce(opt, "ramAdmission", "ram_admission")
        admit_pct = _coalesce(opt, "ramAdmitPct", "ram_admit_pct")
        resume_pct = _coalesce(opt, "ramResumePct", "ram_resume_pct")
        poll_ms = _coalesce(opt, "admissionPollMs", "admission_poll_ms")
        max_wait_ms = _coalesce(opt, "admissionMaxWaitMs", "admission_max_wait_ms")
        headroom_ticks = _coalesce(opt, "growHeadroomTicks", "grow_headroom_ticks")
        subtract_cache = _coalesce(opt, "subtractPageCache", "subtract_page_cache")
        cost_tracking = _coalesce(opt, "stepCostTracking", "step_cost_tracking")

        # The gate must sit at or below the brake (admitting past the ceiling would be pointless), and
        # the resume mark at or below the gate (hysteresis only makes sense downwards).
        admit = min(ceiling_pct, float(admit_pct) if admit_pct is not None else _DEFAULT_RAM_ADMIT_PCT)
        resume = min(admit, float(resume_pct) if resume_pct is not None else _DEFAULT_RAM_RESUME_PCT)

        return ConcurrencyConfig(
            mode="adaptive",
            limit=start,
            min=minimum,
            max=maximum,
            ram_ceiling_pct=ceiling_pct,
            cpu_ceiling_pct=float(cpu_ceiling) if cpu_ceiling is not None else None,
            tick_ms=int(tick_ms) if tick_ms is not None else _DEFAULT_TICK_MS,
            ram_admission=bool(admission) if admission is not None else True,
            ram_admit_pct=admit,
            ram_resume_pct=resume,
            admission_poll_ms=max(1, int(poll_ms)) if poll_ms is not None else _DEFAULT_ADMISSION_POLL_MS,
            admission_max_wait_ms=(
                max(0, int(max_wait_ms)) if max_wait_ms is not None else _DEFAULT_ADMISSION_MAX_WAIT_MS
            ),
            grow_headroom_ticks=(
                max(1, int(headroom_ticks)) if headroom_ticks is not None else _DEFAULT_GROW_HEADROOM_TICKS
            ),
            subtract_page_cache=bool(subtract_cache) if subtract_cache is not None else True,
            step_cost_tracking=bool(cost_tracking) if cost_tracking is not None else True,
        )

    raise TypeError(f"unsupported concurrency option type {type(opt).__name__}; expected int, str, or dict")


def cgroup_v2_memory_dir(
    root: str = _CGROUP_V2_ROOT, proc_cgroup: str = _PROC_SELF_CGROUP
) -> Optional[str]:
    """The cgroup v2 directory holding THIS process's memory files, or None if there is no cgroup v2.

    Under Kubernetes the container has its own cgroup namespace, so ``/sys/fs/cgroup`` is already the
    container's own directory — that's the fast path and the only one the TS controller has. Without a
    namespace (a bare systemd/docker host) the mount root belongs to the ROOT cgroup, which has no
    memory files at all, so we fall back to the relative path ``/proc/self/cgroup`` reports. Resolved
    ONCE and used for BOTH the usage and the limit, so the ratio can never mix two different cgroups.
    """
    if os.path.exists(os.path.join(root, "memory.current")):
        return root
    try:
        with open(proc_cgroup, "r", encoding="ascii") as handle:
            for line in handle:
                parts = line.strip().split(":", 2)
                if len(parts) != 3 or parts[0] != "0":
                    continue  # a v1 controller line; only the unified ("0::") line is cgroup v2
                relative = parts[2].lstrip("/")
                candidate = os.path.join(root, relative) if relative else root
                if os.path.exists(os.path.join(candidate, "memory.current")):
                    return candidate
    except OSError:
        pass
    return None


def _read_cgroup_memory_limit(
    *, v2_dir: Optional[str] = _AUTO, v1_root: str = _CGROUP_V1_MEMORY_ROOT
) -> Optional[int]:
    """The process memory ceiling in bytes, read once (cgroup v2, then v1, then host total).

    Returns None only if every source is unreadable. Any value >= the "unlimited" sentinel falls
    through to the host total (a real ceiling for ``rssPct``).

    Known limitation: if OUR cgroup sets no limit but an ancestor does, we fall through to the host
    total instead of walking up the hierarchy. Kubernetes puts the limit on the container's own cgroup
    (the case that matters), and the alternative — pairing an ancestor's limit with our own usage —
    would be a worse mismatch."""
    # cgroup v2
    directory = cgroup_v2_memory_dir() if v2_dir == _AUTO else v2_dir
    if directory is not None:
        value = _read_int_file(os.path.join(directory, "memory.max"))
        if value is not None and 0 < value < _CGROUP_UNLIMITED:
            return value
    # cgroup v1
    value = _read_int_file(os.path.join(v1_root, "memory.limit_in_bytes"))
    if value is not None and 0 < value < _CGROUP_UNLIMITED:
        return value
    # host total
    try:
        page_size = os.sysconf("SC_PAGE_SIZE")
        phys_pages = os.sysconf("SC_PHYS_PAGES")
        if page_size > 0 and phys_pages > 0:
            return page_size * phys_pages
    except (ValueError, OSError, AttributeError):
        pass
    return None


def _read_int_file(path: str) -> Optional[int]:
    """Read a file holding a single integer (cgroup v2 ``memory.max`` may hold the literal ``max``)."""
    try:
        with open(path, "r", encoding="ascii") as handle:
            text = handle.read().strip()
    except (OSError, ValueError):
        return None
    if not text or text == "max":
        return None
    try:
        return int(text)
    except ValueError:
        return None


def _read_stat_field(path: str, *fields: str) -> Optional[int]:
    """First of ``fields`` found in a ``key value`` file (cgroup ``memory.stat``), in bytes."""
    try:
        with open(path, "r", encoding="ascii") as handle:
            table = {}
            for line in handle:
                parts = line.split()
                if len(parts) >= 2:
                    table[parts[0]] = parts[1]
    except OSError:
        return None
    for name in fields:
        raw = table.get(name)
        if raw is None:
            continue
        try:
            return int(raw)
        except ValueError:
            return None
    return None


def _read_proc_vmrss(path: str = _PROC_SELF_STATUS) -> Optional[int]:
    """Current resident set size in bytes from ``/proc/self/status`` (``VmRSS`` is in kB)."""
    try:
        with open(path, "r", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    parts = line.split()
                    if len(parts) >= 2:
                        return int(parts[1]) * 1024
    except (OSError, ValueError):
        return None
    return None


def _read_process_peak_rss() -> Optional[int]:
    """Process HIGH-WATER RSS in bytes via ``getrusage`` (``ru_maxrss`` is KiB on Linux).

    This is a PEAK and never decreases, so it must NOT be used as the brake's numerator (that was the
    2026-09 OOM bug: the brake latched for the life of the process). It is kept for two narrow uses:
    the last-resort fallback when no cgroup and no ``/proc`` is readable, and per-step cost learning,
    where "how high did the peak move while exactly this step ran" is precisely the right question."""
    try:
        max_rss_kib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except (ValueError, OSError):
        return None
    if max_rss_kib <= 0:
        return None
    return int(max_rss_kib) * 1024


def probe_memory_usage(
    *,
    v2_dir: Optional[str] = _AUTO,
    v1_root: str = _CGROUP_V1_MEMORY_ROOT,
    proc_status: str = _PROC_SELF_STATUS,
    subtract_page_cache: bool = True,
) -> Tuple[Optional[int], str]:
    """CURRENT memory usage in bytes plus a label naming where it came from.

    Source order, best first:

    1. cgroup v2 ``memory.current`` — the charge the kernel's OOM killer acts on, and the same
       denominator-mate as ``memory.max``. It INCLUDES page cache charged to the cgroup.
    2. cgroup v1 ``memory.usage_in_bytes``.
    3. ``/proc/self/status`` ``VmRSS`` — this process only (misses sibling processes in the container
       and page cache, so it can under-report a container's real charge).
    4. ``ru_maxrss`` — a PEAK, hence a last resort: better than flying blind, but it never falls.

    ``subtract_page_cache`` (default True) subtracts ``memory.stat``'s ``inactive_file`` from the
    cgroup number, giving the "working set" — the same figure kubelet computes for eviction and
    cAdvisor reports as ``working_set_bytes``. Justification: inactive file pages are clean, reclaimable
    cache; under pressure the kernel drops them instead of OOM-killing. A worker that streams a few GB
    through parquet/S3 temp files would otherwise read as ~100% full while almost none of it is
    unreclaimable, and a brake that can never release is how you get idle workers forever. We subtract
    ONLY ``inactive_file``: active file pages and anything anonymous may not be reclaimable in time, and
    being too lax here is an OOM kill, not a slowdown. Set it False for the raw charge.
    """
    directory = cgroup_v2_memory_dir() if v2_dir == _AUTO else v2_dir
    if directory is not None:
        current = _read_int_file(os.path.join(directory, "memory.current"))
        if current is not None and current > 0:
            if subtract_page_cache:
                inactive = _read_stat_field(os.path.join(directory, "memory.stat"), "inactive_file")
                if inactive is not None and 0 <= inactive < current:
                    return current - inactive, "cgroup_v2_working_set"
            return current, "cgroup_v2_current"

    usage = _read_int_file(os.path.join(v1_root, "memory.usage_in_bytes"))
    if usage is not None and usage > 0:
        if subtract_page_cache:
            inactive = _read_stat_field(
                os.path.join(v1_root, "memory.stat"), "total_inactive_file", "inactive_file"
            )
            if inactive is not None and 0 <= inactive < usage:
                return usage - inactive, "cgroup_v1_working_set"
        return usage, "cgroup_v1_usage"

    rss = _read_proc_vmrss(proc_status)
    if rss is not None and rss > 0:
        return rss, "proc_vmrss"

    peak = _read_process_peak_rss()
    if peak is not None:
        return peak, "rusage_maxrss_peak"
    return None, "unavailable"


def read_memory_usage_bytes(**kwargs: Any) -> Optional[int]:
    """CURRENT memory usage in bytes (see :func:`probe_memory_usage` for the source order)."""
    return probe_memory_usage(**kwargs)[0]


def _median(sorted_values) -> float:
    count = len(sorted_values)
    if count == 0:
        return 0.0
    mid = count // 2
    if count % 2 == 1:
        return float(sorted_values[mid])
    return (sorted_values[mid - 1] + sorted_values[mid]) / 2.0


def _percentile(sorted_values, pct: float) -> float:
    count = len(sorted_values)
    if count == 0:
        return 0.0
    index = min(count - 1, max(0, math.ceil(pct * count) - 1))
    return float(sorted_values[index])


@dataclass
class _InFlight:
    """One task the controller has admitted, used for the in-flight count and cost learning."""

    name: Optional[str]
    # Memory usage when this task started, and the process peak then — both only captured for a task
    # that started SOLO (nothing else in flight), because only then is a delta attributable to it.
    usage_at_start: Optional[int] = None
    peak_at_start: Optional[int] = None
    # Largest usage growth seen while it ran (sampled on each control tick).
    growth: int = 0
    # Still the ONLY task in flight? Cleared the moment anything else starts.
    solo: bool = True


class AdaptiveController:
    """Tracks live worker state and (in adaptive mode) tunes concurrency every ``tickMs``.

    Wrap the job processor: await :meth:`await_admission` before a task begins, call :meth:`on_start`
    when it begins and :meth:`on_settle` when it finishes (with its duration in ms and ok/err).
    :meth:`snapshot` returns the ``WorkerStatus`` dict for the heartbeat. :meth:`start` spawns the
    asyncio control loop; :meth:`stop` ends it.
    """

    def __init__(
        self,
        config: ConcurrencyConfig,
        *,
        rss_reader: Optional[Callable[[], Optional[int]]] = None,
        rss_limit_reader: Optional[Callable[[], Optional[int]]] = None,
        peak_reader: Optional[Callable[[], Optional[int]]] = None,
    ) -> None:
        self.config = config
        self.limit = config.limit
        # (monotonic_ts, duration_ms, ok) of the last ~100 completions.
        self._window: Deque[Tuple[float, float, bool]] = deque(maxlen=_WINDOW_SIZE)
        self._rtt_long: Optional[float] = None
        self._last_adjust: Optional[Dict[str, Any]] = None
        self._completions_this_tick = 0
        self._stall_ticks = 0
        self._cpu_pct: Optional[float] = None
        # Memory readers are injectable for testing (and to let a host override the source).
        # ``rss_reader`` must return CURRENT usage, not a peak (see the module docstring); the ceiling is
        # read once and cached — it does not change over a process's life. The cgroup v2 directory is
        # resolved ONCE and shared by both default readers, so usage and ceiling can never come from two
        # different cgroups (and we don't re-walk /proc/self/cgroup on every read).
        self._cgroup_v2_dir = (
            cgroup_v2_memory_dir() if rss_reader is None or rss_limit_reader is None else None
        )
        if rss_reader is not None:
            self._rss_reader = rss_reader
            self._usage_source = "custom"
        else:
            subtract = config.subtract_page_cache
            v2_dir = self._cgroup_v2_dir
            self._rss_reader = lambda: read_memory_usage_bytes(
                v2_dir=v2_dir, subtract_page_cache=subtract
            )
            # Probed once so the heartbeat can say WHICH source a pod is actually reading.
            self._usage_source = probe_memory_usage(v2_dir=v2_dir, subtract_page_cache=subtract)[1]
        self._rss_limit_reader = rss_limit_reader or (
            lambda: _read_cgroup_memory_limit(v2_dir=self._cgroup_v2_dir)
        )
        self._peak_reader = peak_reader or _read_process_peak_rss
        self._rss_limit_cache: Optional[int] = None
        self._rss_limit_read = False
        # -- admission state ------------------------------------------------------------------------
        # In-flight tasks by token (insertion-ordered, so the oldest is first).
        self._inflight: Dict[int, _InFlight] = {}
        self._token_seq = 0
        # Per step NAME: the last few observed solo costs in bytes; the estimate is their max.
        self._step_costs: Dict[str, Deque[int]] = {}
        # Usage last seen with NOTHING in flight — the baseline the gate adds reservations to.
        self._idle_usage: Optional[int] = None
        # Consecutive ticks with real headroom; growth requires config.grow_headroom_ticks of them.
        self._headroom_ticks = 0
        # Gate latch (hysteresis) + counters surfaced on the heartbeat.
        self._deferring = False
        self._waiting = 0
        self._deferrals = 0
        self._last_deferred_at: Optional[int] = None
        # True until the FIRST task settles: while it holds, the worker refuses to run a second task
        # concurrently, so it always has one real measurement before it parallelises (try_admit rule 5).
        self._probe_pending = True
        # Set on shutdown: waiters stop waiting so a graceful close is never held up by the gate.
        self._draining = False
        # CPU baseline for the os.times() delta.
        self._last_cpu_proc: Optional[float] = None
        self._last_cpu_wall: Optional[float] = None
        # asyncio control loop handle.
        self._apply_cb: Optional[Callable[[int], None]] = None
        self._task: "Optional[asyncio.Task[Any]]" = None
        self._stop_event: Optional[asyncio.Event] = None

    @property
    def mode(self) -> str:
        return self.config.mode

    @property
    def in_flight(self) -> int:
        """Tasks the controller has admitted and not yet settled (read-only)."""
        return len(self._inflight)

    # -- processor hooks -------------------------------------------------------------------------

    def on_start(self, name: Optional[str] = None) -> int:
        """A task has started — one more in flight. Returns a token to hand back to :meth:`on_settle`.

        ``name`` is the step/workflow name, used for per-name cost learning and for the gate's
        reservation. Both are optional: a caller that passes neither name nor token still gets correct
        in-flight accounting."""
        solo = not self._inflight
        # Anything already running is no longer alone, so its growth is no longer attributable to it.
        for record in self._inflight.values():
            record.solo = False
        self._token_seq += 1
        token = self._token_seq
        record = _InFlight(name=name, solo=solo)
        if solo and self.config.step_cost_tracking:
            record.usage_at_start = self._usage_bytes()
            record.peak_at_start = self._peak_reader()
        self._inflight[token] = record
        return token

    def on_settle(
        self, duration_ms: float, ok: bool, kind: str = "step", token: Optional[int] = None
    ) -> None:
        """A task has settled — decrement in flight and (for STEP tasks only) record its duration.

        ``kind`` is ``'step'`` or ``'workflow'``. A unified worker shares ONE concurrency pool for
        workflow turns and step tasks (correct — turns SUSPEND, they don't block), so ``inFlight``
        counts BOTH. But the latency/throughput/p95 measurement window must reflect only STEP
        completions: a 5ms workflow turn next to a 2s step would corrupt the gradient that tunes the
        limit. So a ``'workflow'`` settle decrements in-flight and returns without touching the window
        or the per-tick completion count. (Defaults to ``'step'`` for callers that don't tag.)

        ``token`` is what :meth:`on_start` returned. Without it the OLDEST in-flight record is retired
        instead, so an integration that predates tokens keeps counting correctly (it just can't learn
        a per-name cost)."""
        self._probe_pending = False
        record = self._inflight.pop(token, None) if token is not None else None
        if record is None and self._inflight:
            oldest = next(iter(self._inflight))
            record = self._inflight.pop(oldest)
        if record is not None and kind == "step":
            self._learn_step_cost(record)
        if not self._inflight:
            # Back to idle: this is the cleanest baseline we'll get for the gate's reservations.
            usage = self._usage_bytes()
            if usage is not None:
                self._idle_usage = usage
        if kind != "step":
            return
        self._window.append((time.monotonic(), float(duration_ms), bool(ok)))
        self._completions_this_tick += 1

    # -- admission control ------------------------------------------------------------------------

    def try_admit(self, name: Optional[str] = None) -> bool:
        """Is there room to START one more task right now? Cheap (a couple of small file reads).

        The rule, in order:

        1. Not adaptive, or ``ramAdmission`` off -> always yes (opt-out, and a fixed limit is the
           user's explicit promise).
        2. **Nothing in flight -> always yes**, whatever the reading. A worker that refuses its own
           first task can never free the memory it is waiting for; this is the anti-deadlock rule.
        3. Already at the live ``limit`` -> no. This makes a limit COLLAPSE effective immediately for
           jobs BullMQ had already fetched, instead of only from the next scheduling pass.
        4. No usage or no ceiling readable -> yes (never gate on a number we don't have).
        5. **The very first task of a process runs alone.** Until something has settled we have not a
           single measurement, and a step's cost is invisible at admission time (it allocates AFTER it
           starts) — so N jobs arriving into a fresh pod would all read the same low usage and all get
           in, which is exactly how the incident happened. Bounded by ONE settle, not by a timer.
        6. Otherwise admit only while the projected usage stays under the mark: ``ramAdmitPct``
           normally, ``ramResumePct`` once we have started deferring (hysteresis).

        "Projected" is ``max(usage + cost(new), idle_baseline + cost(new) + Σ cost(in-flight))``. The
        second term matters because usage at admission time does NOT yet include what the steps already
        admitted are about to allocate. Costs are learned per name (see :meth:`_learn_step_cost`); a name
        never observed is charged the largest cost learned for ANY name, which is conservative without
        inventing a number out of thin air."""
        config = self.config
        if config.mode != "adaptive" or not config.ram_admission:
            return True
        if not self._inflight:
            usage = self._usage_bytes()
            if usage is not None:
                self._idle_usage = usage
            self._deferring = False
            return True
        if len(self._inflight) >= self.limit:
            return False
        usage = self._usage_bytes()
        limit_bytes = self._rss_limit_bytes()
        if usage is None or limit_bytes is None or limit_bytes <= 0:
            return True
        if config.step_cost_tracking and self._probe_pending and not self._step_costs:
            return False  # rule 5: measure one task before ever running two
        new_cost = self._step_cost(name)
        measured = usage + new_cost
        projected = measured
        if self._idle_usage is not None:
            reserved = sum(self._step_cost(r.name) for r in self._inflight.values()) + new_cost
            projected = max(measured, self._idle_usage + reserved)
        mark = config.ram_resume_pct if self._deferring else config.ram_admit_pct
        admitted = (100.0 * projected / limit_bytes) <= mark
        self._deferring = not admitted
        return admitted

    async def await_admission(
        self, name: Optional[str] = None, *, abort: Optional[Callable[[], bool]] = None
    ) -> bool:
        """Block until :meth:`try_admit` says yes, then return True.

        This is BACKPRESSURE, not rejection: the caller keeps holding its job (BullMQ renews the lock
        while we wait), so a deferred task never becomes a failed step — it just starts later. Returns
        False if it gave up waiting (``abort()`` went true, e.g. the run was cancelled, or
        ``admissionMaxWaitMs`` elapsed); the caller should then run the task anyway — a cancelled task
        returns immediately and a bounded wait must not strand work forever."""
        if self.try_admit(name):
            return True
        config = self.config
        poll = max(0.001, config.admission_poll_ms / 1000.0)
        deadline = (
            time.monotonic() + config.admission_max_wait_ms / 1000.0
            if config.admission_max_wait_ms > 0
            else None
        )
        self._waiting += 1
        self._deferrals += 1
        self._last_deferred_at = int(time.time() * 1000)
        try:
            while True:
                if self._draining:
                    return False  # shutting down: never hold a graceful close open on the gate
                if abort is not None:
                    try:
                        if abort():
                            return False
                    except Exception:  # noqa: BLE001 — a broken predicate must not strand the task
                        pass
                if deadline is not None and time.monotonic() >= deadline:
                    return False
                await asyncio.sleep(poll)
                if self.try_admit(name):
                    return True
        finally:
            self._waiting = max(0, self._waiting - 1)

    def _step_cost(self, name: Optional[str]) -> int:
        """Estimated memory a step of ``name`` needs: the max of its recent SOLO observations.

        A name never observed is charged the largest cost learned for ANY name — conservative, but still
        a number this worker actually measured rather than an invented default. With nothing learned at
        all it is 0, and rule 5 of :meth:`try_admit` covers that window.

        An UNNAMED task is charged 0: the only unnamed tasks are workflow turns (a replay that suspends —
        cheap by construction) and callers that predate the ``name`` argument. Those still get the
        usage-based half of the gate."""
        if not self.config.step_cost_tracking or not name:
            return 0
        samples = self._step_costs.get(name)
        if samples:
            return max(samples)
        return max((max(s) for s in self._step_costs.values() if s), default=0)

    def _learn_step_cost(self, record: _InFlight) -> None:
        """Record what a step of this name cost, but ONLY from a run that was alone start to finish.

        Attribution with several steps in flight is guesswork, and a wrong (inflated) number would
        serialize a worker forever — so we simply don't learn from those. In practice the first job of
        a batch IS solo (an adaptive worker starts at ``min``), which is exactly when the estimate is
        needed. The observation is the max of: growth sampled on the control ticks during the run, the
        growth still visible at settle, and how far the process PEAK moved while the step ran — the
        last one catches a step that allocated and freed between two ticks."""
        config = self.config
        if not config.step_cost_tracking or not record.solo or not record.name:
            return
        if record.usage_at_start is None:
            return
        observed = record.growth
        usage = self._usage_bytes()
        if usage is not None:
            observed = max(observed, usage - record.usage_at_start)
        if record.peak_at_start is not None:
            peak = self._peak_reader()
            if peak is not None:
                observed = max(observed, peak - record.peak_at_start)
        samples = self._step_costs.setdefault(record.name, deque(maxlen=_STEP_COST_SAMPLES))
        samples.append(max(0, int(observed)))

    # -- control loop ----------------------------------------------------------------------------

    def start(self, apply_cb: Optional[Callable[[int], None]] = None) -> None:
        """Spawn the control loop as an asyncio task. ``apply_cb(limit)`` is invoked whenever the
        limit changes (the runner wires it to ``bull_worker.opts['concurrency'] = limit``). Safe to
        call for a fixed worker too: the loop still measures CPU/RSS for the status snapshot but
        never changes the limit."""
        self._apply_cb = apply_cb
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run())

    def begin_drain(self) -> None:
        """Shutting down: release everything waiting at the gate.

        A waiter is holding a BullMQ job whose ``process`` callback has not returned, so a graceful
        ``close()`` waits for it. Making waiters give up (they run their task, which then settles
        normally) bounds shutdown by a task duration instead of by "when memory frees"."""
        self._draining = True

    def stop(self) -> None:
        """End the control loop (best-effort)."""
        if self._stop_event is not None:
            self._stop_event.set()
        if self._task is not None:
            self._task.cancel()

    async def _run(self) -> None:
        assert self._stop_event is not None
        interval = max(0.001, self.config.tick_ms / 1000.0)
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
            if self._stop_event.is_set():
                break
            try:
                self.tick()
            except Exception:  # noqa: BLE001 — a control hiccup must never kill the worker
                pass

    def tick(self) -> None:
        """One control iteration: refresh CPU + memory, update the counters, and (adaptive only) decide.

        Synchronous and side-effecting so it is trivially unit-testable without Redis or asyncio —
        feed completions via :meth:`on_settle`, call :meth:`tick`, and inspect :attr:`limit`."""
        self._cpu_pct = self._measure_cpu()
        # ONE memory read per tick, shared by cost sampling, the headroom counter and the decision.
        usage = self._usage_bytes()
        usage_pct = self._pct(usage)
        self._sample_step_growth(usage)
        if usage is not None and not self._inflight:
            self._idle_usage = usage
        # Headroom is only credited BELOW the resume mark, so growing back after a brake needs real
        # room, not merely "not over the ceiling". An unreadable usage counts as headroom, which keeps
        # a non-Linux / no-cgroup host behaving exactly as it did before this gate existed.
        if usage_pct is None or usage_pct <= self.config.ram_resume_pct:
            self._headroom_ticks += 1
            # Usage really fell: release the gate's hysteresis latch here rather than only on the next
            # admission attempt, so an idle worker's heartbeat never reports a stale "deferring".
            self._deferring = False
        else:
            self._headroom_ticks = 0
        completions = self._completions_this_tick
        self._completions_this_tick = 0
        if completions == 0 and self.in_flight > 0:
            self._stall_ticks += 1
        else:
            self._stall_ticks = 0
        if self.config.mode != "adaptive":
            return
        self._decide(usage_pct)

    def _decide(self, rss_pct: Optional[float] = None) -> None:
        config = self.config
        current = self.limit
        new_limit = current
        reason: Optional[str] = None

        if rss_pct is None:
            rss_pct = self._rss_pct()
        if rss_pct is not None and rss_pct >= config.ram_ceiling_pct:
            # ASYMMETRIC on purpose. Latency you can walk down 20% a tick; memory you cannot — an
            # allocation that doubles usage in seconds outruns any multiplicative decay, and the
            # penalty for being late is a SIGKILL that orphans every in-flight step. So give the whole
            # limit back in one move and earn it back slowly (grow needs growHeadroomTicks of headroom).
            new_limit = config.min
            reason = "ram_ceiling"
            self._headroom_ticks = 0
            self._deferring = True  # the gate holds new work at ramResumePct until usage really falls
        elif (
            config.cpu_ceiling_pct is not None
            and self._cpu_pct is not None
            and self._cpu_pct >= config.cpu_ceiling_pct
        ):
            new_limit = max(config.min, current - 1)
            reason = "cpu_ceiling"
        elif self._error_rate() > 0.2 or self._stall_ticks >= 2:
            new_limit = max(config.min, current - 1)
            reason = "backpressure"
        else:
            gradient = self._gradient()
            if gradient is not None and gradient < 0.7:
                new_limit = max(config.min, math.floor(current * gradient))
                reason = "shrink"
            elif (
                gradient is not None
                and gradient >= 0.9
                and self.in_flight >= current * 0.8
                and self._headroom_ticks >= config.grow_headroom_ticks
            ):
                # Growing is the one move that can CAUSE an OOM, so it needs sustained headroom —
                # several consecutive ticks under ramResumePct — not just a healthy latency gradient.
                new_limit = min(config.max, current + 1)
                reason = "grow"

        new_limit = max(config.min, min(config.max, new_limit))
        if new_limit != current and reason is not None:
            self._last_adjust = {
                "at": int(time.time() * 1000),
                "from": current,
                "to": new_limit,
                "reason": reason,
            }
            self.limit = new_limit
            if self._apply_cb is not None:
                try:
                    self._apply_cb(new_limit)
                except Exception:  # noqa: BLE001 — applying the limit must not break the loop
                    pass

    # -- metrics ---------------------------------------------------------------------------------

    def _gradient(self) -> Optional[float]:
        """``rttLong / rttShort`` clamped to (0, 1]. Updates the rttLong EWMA as a side effect, so it
        is called exactly once per tick (from :meth:`_decide`)."""
        durations = [duration for (_, duration, _) in self._window]
        if not durations:
            return None
        durations.sort()
        current_min = durations[0]
        if self._rtt_long is None:
            self._rtt_long = current_min
        else:
            self._rtt_long = _RTT_LONG_ALPHA * self._rtt_long + (1.0 - _RTT_LONG_ALPHA) * current_min
        rtt_short = _median(durations)
        if rtt_short <= 0:
            return 1.0
        return min(1.0, self._rtt_long / rtt_short)

    def _error_rate(self) -> float:
        if not self._window:
            return 0.0
        errors = sum(1 for (_, _, ok) in self._window if not ok)
        return errors / len(self._window)

    def _throughput_per_min(self) -> Optional[float]:
        if len(self._window) < 2:
            return None
        oldest = self._window[0][0]
        newest = self._window[-1][0]
        span = newest - oldest
        if span <= 0:
            return None
        return (len(self._window) / span) * 60.0

    def _p95_ms(self) -> Optional[float]:
        if not self._window:
            return None
        durations = sorted(duration for (_, duration, _) in self._window)
        return _percentile(durations, 0.95)

    def _rss_limit_bytes(self) -> Optional[int]:
        if not self._rss_limit_read:
            self._rss_limit_cache = self._rss_limit_reader()
            self._rss_limit_read = True
        return self._rss_limit_cache

    def _usage_bytes(self) -> Optional[int]:
        """Current memory usage in bytes, never a peak. Guarded: a reader that raises must not take
        the worker (or the control loop) down with it."""
        try:
            return self._rss_reader()
        except Exception:  # noqa: BLE001
            return None

    def _pct(self, usage: Optional[int]) -> Optional[float]:
        limit = self._rss_limit_bytes()
        if usage is None or limit is None or limit <= 0:
            return None
        return 100.0 * usage / limit

    def _rss_pct(self) -> Optional[float]:
        return self._pct(self._usage_bytes())

    def _sample_step_growth(self, usage: Optional[int]) -> None:
        """Per-tick sample of how far usage has grown since a solo task started (its cost estimate)."""
        if usage is None or not self.config.step_cost_tracking:
            return
        for record in self._inflight.values():
            if record.solo and record.usage_at_start is not None:
                record.growth = max(record.growth, usage - record.usage_at_start)

    def _measure_cpu(self) -> Optional[float]:
        """Process CPU percent since the last tick via ``os.times()`` deltas. Can exceed 100 on
        multiple cores (handlers run in threads). Returns None on the first tick (no baseline) or
        when no wall time elapsed."""
        try:
            times = os.times()
        except (OSError, ValueError):
            return None
        proc = times.user + times.system
        wall = times.elapsed
        previous_proc = self._last_cpu_proc
        previous_wall = self._last_cpu_wall
        self._last_cpu_proc = proc
        self._last_cpu_wall = wall
        if previous_proc is None or previous_wall is None:
            return None
        wall_delta = wall - previous_wall
        if wall_delta <= 0:
            return self._cpu_pct  # keep the last reading rather than emit a bogus spike
        proc_delta = max(0.0, proc - previous_proc)
        return (proc_delta / wall_delta) * 100.0

    # -- snapshot --------------------------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        """The ``WorkerStatus`` dict (camelCase keys) stamped on every heartbeat. Fields that cannot
        be measured are omitted (the contract marks them optional). ``runtime`` is always ``'python'``.

        ``rssBytes``/``rssPct`` keep their documented meaning; they are now CURRENT usage rather than
        the process peak. ``memory`` is an additive Python-only block (which source the numbers come
        from, the gate's state and what it has learned per step name) — TS consumers ignore unknown
        keys, so it doesn't change the cross-SDK contract."""
        concurrency: Dict[str, Any] = {"mode": self.config.mode, "limit": self.limit}
        if self.config.mode == "adaptive":
            concurrency["min"] = self.config.min
            concurrency["max"] = self.config.max

        status: Dict[str, Any] = {
            "runtime": "python",
            "concurrency": concurrency,
            "inFlight": self.in_flight,
        }

        rss = self._usage_bytes()
        limit = self._rss_limit_bytes()
        if rss is not None:
            status["rssBytes"] = rss
        if limit is not None:
            status["rssLimitBytes"] = limit
            if rss is not None and limit > 0:
                status["rssPct"] = 100.0 * rss / limit

        if self._cpu_pct is not None:
            status["cpuPct"] = self._cpu_pct

        throughput = self._throughput_per_min()
        if throughput is not None:
            status["throughputPerMin"] = throughput

        p95 = self._p95_ms()
        if p95 is not None:
            status["p95Ms"] = p95

        if self._last_adjust is not None:
            status["lastAdjust"] = self._last_adjust

        memory: Dict[str, Any] = {"source": self._usage_source}
        if self._idle_usage is not None:
            memory["idleUsageBytes"] = self._idle_usage
        if self.config.mode == "adaptive" and self.config.ram_admission:
            memory["gate"] = "deferring" if self._deferring else "open"
            memory["admitPct"] = self.config.ram_admit_pct
            memory["resumePct"] = self.config.ram_resume_pct
            memory["waiting"] = self._waiting
            memory["deferrals"] = self._deferrals
            memory["headroomTicks"] = self._headroom_ticks
            if self._last_deferred_at is not None:
                memory["lastDeferredAt"] = self._last_deferred_at
        if self._step_costs:
            memory["stepCostBytes"] = {
                name: max(samples) for name, samples in self._step_costs.items() if samples
            }
        status["memory"] = memory

        return status
