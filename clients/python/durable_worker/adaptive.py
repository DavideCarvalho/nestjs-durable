"""Adaptive concurrency controller + live worker status snapshot.

The Python half of "Observable + Adaptive Workers". It mirrors the TypeScript controller in
``packages/worker/src/adaptive-concurrency.ts`` EXACTLY — same gradient-limit algorithm, same
decision order, and the same ``WorkerStatus`` JSON shape (camelCase keys) so the engine can
aggregate Node and Python workers uniformly and Telescope/the dashboard render either identically.

Two responsibilities:

* **Observability (both modes).** Wrap the job processor with :meth:`on_start` / :meth:`on_settle`
  so the controller tracks ``inFlight``, a rolling window of completion durations + ok/err, RSS
  (vs the cgroup memory ceiling), CPU, throughput and p95. :meth:`snapshot` returns the
  ``WorkerStatus`` dict the heartbeat writer stamps on every beat. A FIXED worker still emits this.

* **Adaptive control (adaptive mode only).** A control loop every ``tickMs`` recomputes a gradient
  (``rttLong``/``rttShort``) and adjusts the limit (ram_ceiling / cpu_ceiling / backpressure /
  shrink / grow / hold), only GROWING when saturated. Standard Vegas/Gradient2 practice.

Stdlib only — ``resource``, ``os``, ``time`` — no new dependencies.

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


@dataclass
class ConcurrencyConfig:
    """Normalized concurrency configuration produced by :func:`resolve_concurrency`.

    ``mode`` is ``'fixed'`` or ``'adaptive'``. For a fixed worker ``limit`` is the constant N. For
    an adaptive worker ``limit`` is the START value (clamped into ``[min, max]``).
    """

    mode: str
    limit: int
    min: int
    max: int
    ram_ceiling_pct: float
    cpu_ceiling_pct: Optional[float]
    tick_ms: int


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
        return ConcurrencyConfig(
            mode="adaptive",
            limit=start,
            min=minimum,
            max=maximum,
            ram_ceiling_pct=float(ram_ceiling) if ram_ceiling is not None else _DEFAULT_RAM_CEILING_PCT,
            cpu_ceiling_pct=float(cpu_ceiling) if cpu_ceiling is not None else None,
            tick_ms=int(tick_ms) if tick_ms is not None else _DEFAULT_TICK_MS,
        )

    raise TypeError(f"unsupported concurrency option type {type(opt).__name__}; expected int, str, or dict")


def _read_cgroup_memory_limit() -> Optional[int]:
    """The process memory ceiling in bytes, read once (cgroup v2, then v1, then host total).

    Returns None only if every source is unreadable. Any value >= the "unlimited" sentinel falls
    through to the host total (a real ceiling for ``rssPct``)."""
    # cgroup v2
    value = _read_int_file("/sys/fs/cgroup/memory.max")
    if value is not None and 0 < value < _CGROUP_UNLIMITED:
        return value
    # cgroup v1
    value = _read_int_file("/sys/fs/cgroup/memory/memory.limit_in_bytes")
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


def _read_process_rss() -> Optional[int]:
    """Resident set size in BYTES via ``getrusage``. On Linux ``ru_maxrss`` is KiB (multiply 1024).

    Note this is the process HIGH-WATER mark (max RSS), the stdlib-only signal available without
    psutil; it never under-reports the ceiling pressure, which is the conservative choice for a
    hard brake."""
    try:
        max_rss_kib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except (ValueError, OSError):
        return None
    if max_rss_kib <= 0:
        return None
    return int(max_rss_kib) * 1024


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


class AdaptiveController:
    """Tracks live worker state and (in adaptive mode) tunes concurrency every ``tickMs``.

    Wrap the job processor: call :meth:`on_start` when a task begins and :meth:`on_settle` when it
    finishes (with its duration in ms and ok/err). :meth:`snapshot` returns the ``WorkerStatus``
    dict for the heartbeat. :meth:`start` spawns the asyncio control loop; :meth:`stop` ends it.
    """

    def __init__(
        self,
        config: ConcurrencyConfig,
        *,
        rss_reader: Optional[Callable[[], Optional[int]]] = None,
        rss_limit_reader: Optional[Callable[[], Optional[int]]] = None,
    ) -> None:
        self.config = config
        self.limit = config.limit
        self.in_flight = 0
        # (monotonic_ts, duration_ms, ok) of the last ~100 completions.
        self._window: Deque[Tuple[float, float, bool]] = deque(maxlen=_WINDOW_SIZE)
        self._rtt_long: Optional[float] = None
        self._last_adjust: Optional[Dict[str, Any]] = None
        self._completions_this_tick = 0
        self._stall_ticks = 0
        self._cpu_pct: Optional[float] = None
        # RSS readers are injectable for testing (and to let a host override the source). The limit
        # is read once and cached — it does not change over a process's life.
        self._rss_reader = rss_reader or _read_process_rss
        self._rss_limit_reader = rss_limit_reader or _read_cgroup_memory_limit
        self._rss_limit_cache: Optional[int] = None
        self._rss_limit_read = False
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

    # -- processor hooks -------------------------------------------------------------------------

    def on_start(self) -> None:
        """A task has started — one more in flight."""
        self.in_flight += 1

    def on_settle(self, duration_ms: float, ok: bool, kind: str = "step") -> None:
        """A task has settled — decrement in flight and (for STEP tasks only) record its duration.

        ``kind`` is ``'step'`` or ``'workflow'``. A unified worker shares ONE concurrency pool for
        workflow turns and step tasks (correct — turns SUSPEND, they don't block), so ``inFlight``
        counts BOTH. But the latency/throughput/p95 measurement window must reflect only STEP
        completions: a 5ms workflow turn next to a 2s step would corrupt the gradient that tunes the
        limit. So a ``'workflow'`` settle decrements in-flight and returns without touching the window
        or the per-tick completion count. (Defaults to ``'step'`` for callers that don't tag.)"""
        self.in_flight = max(0, self.in_flight - 1)
        if kind != "step":
            return
        self._window.append((time.monotonic(), float(duration_ms), bool(ok)))
        self._completions_this_tick += 1

    # -- control loop ----------------------------------------------------------------------------

    def start(self, apply_cb: Optional[Callable[[int], None]] = None) -> None:
        """Spawn the control loop as an asyncio task. ``apply_cb(limit)`` is invoked whenever the
        limit changes (the runner wires it to ``bull_worker.opts['concurrency'] = limit``). Safe to
        call for a fixed worker too: the loop still measures CPU/RSS for the status snapshot but
        never changes the limit."""
        self._apply_cb = apply_cb
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run())

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
        """One control iteration: refresh CPU, update the stall counter, and (adaptive only) decide.

        Synchronous and side-effecting so it is trivially unit-testable without Redis or asyncio —
        feed completions via :meth:`on_settle`, call :meth:`tick`, and inspect :attr:`limit`."""
        self._cpu_pct = self._measure_cpu()
        completions = self._completions_this_tick
        self._completions_this_tick = 0
        if completions == 0 and self.in_flight > 0:
            self._stall_ticks += 1
        else:
            self._stall_ticks = 0
        if self.config.mode != "adaptive":
            return
        self._decide()

    def _decide(self) -> None:
        config = self.config
        current = self.limit
        new_limit = current
        reason: Optional[str] = None

        rss_pct = self._rss_pct()
        if rss_pct is not None and rss_pct >= config.ram_ceiling_pct:
            new_limit = max(config.min, math.floor(current * 0.8))
            reason = "ram_ceiling"
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
            elif gradient is not None and gradient >= 0.9 and self.in_flight >= current * 0.8:
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

    def _rss_pct(self) -> Optional[float]:
        rss = self._rss_reader()
        limit = self._rss_limit_bytes()
        if rss is None or limit is None or limit <= 0:
            return None
        return 100.0 * rss / limit

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
        be measured are omitted (the contract marks them optional). ``runtime`` is always ``'python'``."""
        concurrency: Dict[str, Any] = {"mode": self.config.mode, "limit": self.limit}
        if self.config.mode == "adaptive":
            concurrency["min"] = self.config.min
            concurrency["max"] = self.config.max

        status: Dict[str, Any] = {
            "runtime": "python",
            "concurrency": concurrency,
            "inFlight": self.in_flight,
        }

        rss = self._rss_reader()
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

        return status
