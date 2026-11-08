"""Remove a per-job cost from the ``bullmq`` Python port (2.17, the version this SDK pins).

``bullmq.Job.__init__`` builds a fresh ``Scripts`` for every job it constructs — every job a worker
fetches and every job ``Queue.add`` sends. ``Scripts.__init__`` reads 28 Lua files from disk and
``register_script`` SHA1-hashes each of them, so a step worker spent about a third of its CPU there.
A ``Scripts`` holds only the queue's name, keys and registered scripts — nothing per job — so one per
(connection, prefix, queue) serves every job of that queue, as the ``Queue`` and ``Worker`` already
use their own. The Lua sources are read once per process.

``install()`` is idempotent and leaves bullmq untouched when its layout isn't the one patched here.
"""

from __future__ import annotations

import weakref
from typing import Any, Dict, Tuple

_installed = False


def install() -> bool:
    """Patch bullmq; returns whether the patch is active."""
    global _installed
    if _installed:
        return True
    try:
        import bullmq.job as job_module
        import bullmq.scripts as scripts_module
    except ImportError:
        return False
    original = getattr(scripts_module, "Scripts", None)
    if original is None or getattr(job_module, "Scripts", None) is not original:
        return False
    if not callable(getattr(original, "getScript", None)):
        return False

    sources: Dict[str, str] = {}
    read_source = original.getScript

    def get_script(self: Any, name: str) -> str:
        source = sources.get(name)
        if source is None:
            source = read_source(self, name)
            sources[name] = source
        return source

    per_connection: "weakref.WeakKeyDictionary[Any, Dict[Tuple[str, str], Any]]" = (
        weakref.WeakKeyDictionary()
    )

    def shared_scripts(prefix: str, queue_name: str, redis_connection: Any) -> Any:
        try:
            cache = per_connection.setdefault(redis_connection, {})
        except TypeError:  # not weak-referenceable: fall back to one per job
            return original(prefix, queue_name, redis_connection)
        key = (prefix, queue_name)
        scripts = cache.get(key)
        if scripts is None:
            scripts = original(prefix, queue_name, redis_connection)
            cache[key] = scripts
        return scripts

    original.getScript = get_script
    job_module.Scripts = shared_scripts
    _installed = True
    return True
