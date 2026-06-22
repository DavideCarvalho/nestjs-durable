# flip `processing` → `ctx.gather` adoption — ready-to-apply patch

**Date:** 2026-06-22  **Status:** Ready to apply, GATED on: (1) `durable-worker` published with `gather`; (2) DB-env test of the MEL fix. Repo: `flip-python-db`.

Based on the thread-safety audit (2026-06-22): the 7 `processing` handlers are thread-safe to run as a `ctx.gather` fan **except** the MEL write race. Apply Part A (the fix) **first**, then Part B (the parallelization).

## Part A — MEL atomicity fix (independently valuable; safe even sequentially)

`processMelPProcess`/`processMelFocusPProcess` run in BOTH the AF_FLEET and MEL handlers and do a **non-atomic** `DELETE … WHERE base_id` then a separate `to_sql(append)`. Run in parallel for the same base, two threads interleave (`DELETE_A, DELETE_B, append_A, append_B`) → duplicated/lost rows. Make each DELETE+append ONE transaction so concurrent same-base writers serialize at the DB.

**`app/p_processes/mel/process_mel.py`** (around lines 148-154) — replace:
```python
            with eng.connect() as conn:
                conn.execute(
                    text("DELETE FROM proc_mel WHERE base_id = :baseid"),
                    {"baseid": base_id},
                )
                conn.commit()
            combined.to_sql("proc_mel", con=eng, if_exists="append", index=False)
```
with:
```python
            # Atomic DELETE+append in ONE transaction so concurrent same-base writers (this proc
            # runs in both the AF_FLEET and MEL handlers, which a ctx.gather runs in parallel)
            # serialize at the DB instead of interleaving into duplicated/lost rows.
            with eng.begin() as conn:
                conn.execute(
                    text("DELETE FROM proc_mel WHERE base_id = :baseid"),
                    {"baseid": base_id},
                )
                combined.to_sql("proc_mel", con=conn, if_exists="append", index=False)
```

**`app/p_processes/mel/process_mel_focus.py`** (around lines 72-78) — same transform, table `proc_mel_focus`, frame `MGMTs`:
```python
            with eng.begin() as conn:
                conn.execute(
                    text("DELETE FROM proc_mel_focus WHERE base_id = :baseid"),
                    {"baseid": base_id},
                )
                MGMTs.to_sql("proc_mel_focus", con=conn, if_exists="append", index=False)
```

(Alternative considered & rejected: de-duping the MEL procs to a single handler. The transaction fix is lower-risk — it preserves the existing call graph and also fixes the latent non-atomicity that exists today even sequentially. `gather_children` does NOT fix this — it's a DB-level race, not a Python-state one.)

**Verify (needs a MySQL test env):** run the MEL procs concurrently for one base; assert `proc_mel`/`proc_mel_focus` row counts are exactly one generation (no duplication).

## Part B — parallelize the 7 handlers with `ctx.gather`

**`app/durable_processing_workflow_worker.py`** — replace the sequential `for` loop in `processing()` (current lines ~112-137) with a single `ctx.gather`:

```python
@workflows.workflow("processing")
def processing(ctx: WorkflowContext, data: dict):
    proc = data["proc"]
    base_id = data["base_id"]
    task_id = data["task_id"]

    handlers = _resolve_handlers(proc)

    def _body(label, handler):
        # pri_buy_allocation needs the workflow input as `body` (ELMS/PCVMT S3 paths, PriBuy config,
        # durableRunId); the others take only (eng, base_id, file_upload_id). Closure captures label/
        # handler by argument (no late-binding bug). Each body opens its own pooled connection via the
        # shared thread-safe Engine — safe to run concurrently (see the 2026-06-22 thread-safety audit).
        if label == "pri_buy_allocation":
            return lambda: handler(get_eng(), base_id, task_id, data)
        return lambda: handler(get_eng(), base_id, task_id)

    # Run the handlers in parallel and wait for ALL — any failure fails the run (wait_all).
    results = ctx.gather(
        [(f"handle_{label}", _body(label, handler)) for label, handler in handlers]
    )

    merged = {}
    for r in results:
        if isinstance(r, dict):
            merged.update(r)
    return {"context": merged}
```

Notes:
- `ctx.gather` requires the `durable-worker` release that adds it (the local source has it; PyPI `0.10.0` does NOT). Bump `requirements.txt` `durable-worker[redis]==<new>` first.
- `wait_all` (the default) propagates any handler failure to the run — matching the current sequential semantics where a raising handler fails the workflow.
- `proc != "all"` (single handler) becomes a one-item `gather`, which behaves like the single `ctx.step` it replaces.
- Pool: default `QueuePool` (5+10=15) comfortably covers 7 concurrent; no change needed. (If you later fan out per-PProcess instead of per-handler, raise `pool_size`/`max_overflow` and set `pool_timeout`.)

**Verify:** `tests/test_durable_processing_workflow.py` is transport-free and mocks handlers, so it exercises the workflow structure with the new `gather` (needs the new `durable-worker` installed). Then a dev-env run of a real pipeline to confirm the 7 handlers complete in parallel and the merged context matches a sequential run.

## Rollout order
1. Publish `durable-worker` with `gather` (CI).
2. Apply Part A, DB-test the MEL atomicity, ship.
3. Bump `requirements.txt`; apply Part B; run the structure test + a dev pipeline; ship.
4. Watch `/durable` — the `processing` run should now render the 7 `handle_*` as a parallel fan (the dashboard fan render landed in `@dudousxd/nestjs-durable-dashboard`).
