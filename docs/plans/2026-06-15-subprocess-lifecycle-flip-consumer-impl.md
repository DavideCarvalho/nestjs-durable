# Sub-process lifecycle (flip consumer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make flip's durable v2 `/durable` dashboard show each p-process as a distinct, expandable lifecycle row — by emitting per-p-process **run identity + handler group + phase transitions** into the durable step events, and by splitting the single `processing` step into **one durable step per handler**.

**Architecture:** Three components in dependency order. (A) The lib's **Python SDK** (`clients/python/durable_worker`, in the nestjs-durable repo) gains a `sub_event`/phase API mirroring the TS `subEvent` shipped in the lib feature. (B) **flip-python-db** uses it: `PProcess.run()` already mints a `processRunId` and knows its `handler_name` — wire those (+ phase transitions) into the durable sink. (C) **flip-nestjs** splits `planPProcesses` so an `"all"` run enqueues one `ctx.call(processingStep)` per handler instead of one `proc:"all"` call, and bumps the lib version.

**Tech Stack:** Python (pytest), the `durable_worker` Python SDK, TypeScript/NestJS (vitest), `@dudousxd/nestjs-durable-*`, BullMQ transport.

**Upstream:** Lib TS feature (StepEvent `subId`/`group`/`phase` + `StepLogger.subEvent` + dashboard accordion) is DONE and merged to `main` (commit `aed6c65`), pending changesets release. Design: `docs/plans/2026-06-15-extensible-subprocess-lifecycle.md`. Lib impl: `docs/plans/2026-06-15-subprocess-lifecycle-lib-impl.md`.

---

## ⚠️ Coordination & sequencing (read first)

- **Component A (Python SDK `sub_process`/`sub_event`) is DONE + RELEASED** — `durable-worker 0.6.0` on PyPI. The TS dashboard feature is also released. Remaining: B (flip-python-db authors the `processing` workflow) and C (flip-nestjs registers + triggers it).
- **Architecture corrected:** the handler-as-step orchestration lives in **flip-python-db** (a Python-authored `@workflow("processing")`), NOT in flip-nestjs's `planPProcesses` (the original draft was wrong — see the Architecture section). flip-nestjs only `startChild`s the workflow.
- **Dependency order:** A released → **B** (flip-python-db `@workflow("processing")` + `PProcess.run` uses `sub_process`; needs `durable_worker>=0.6.0`) → **C** (flip-nestjs `registerRemote` + `ctx.startChild`, drop the per-proc loop; needs B's workflow worker deployed + a lib bump). B and C are coupled (the group name + the trigger), so land them together.
- **The double-dispatch bug is OUT OF SCOPE** (af_fleet/mel/metadata running 2×). Handler-as-step + run identity make it *display* correctly (distinct steps/rows); they don't stop the double execution. Separate investigation.

---

## Component A — Python SDK: `sub_event` + `sub_process` context manager ✅ DONE (on `main`, unreleased)

**Implemented and merged to `main`** (`clients/python/durable_worker`). Davi asked for an ergonomic API, so beyond the flat primitive there's a context manager. Shipped surface:

```python
from durable_worker import sub_process, sub_event

# Ergonomic (recommended): context manager — auto run-id, auto durationMs, ok on clean exit /
# failed on exception (re-raised) / skip(), logs inside auto-tagged to this sub's run id. No-op
# outside a durable step, so the same business code runs unchanged on a non-durable path.
with sub_process("ProcessKpi", group="AF_FLEET") as sp:
    sp.phase("validating")
    if not valid:
        sp.skip("; ".join(errors)); return
    sp.phase("processing")
    ...  # work; durable_worker.log(...) here is tagged with this run id
# clean exit -> terminal "ok" + measured durationMs

# Flat primitive (mirrors TS StepLogger.subEvent 1:1) — when you manage the id yourself:
sub_event(id="r1", name="ProcessKpi", group="AF_FLEET", phase="processing")
sub_event(id="r1", name="ProcessKpi", group="AF_FLEET", status="ok", data={"durationMs": 42})
```

Under the hood: `StepContext._emit` extended with `sub_id`/`group`/`phase` (emitting camelCase `subId`/`group`/`phase`); `StepContext.sub_event` + module-level `sub_event`; `_SubProcess` context manager (`__enter__`/`__exit__` with `try/finally` state restore, monotonic duration, `.phase()`/`.skip()`/`.fail()`); log lines auto-stamp `subId` from the current sub. Existing `sub()`/`log()`/`set_process()` unchanged — a legacy `sub("x","ok")` still emits no `subId`. Tests in `clients/python/tests/test_sub_process.py` (9). The dashboard already consumes `subId`/`group`/`phase` (TS feature shipped).

### Task A2: Release the Python SDK to PyPI ✅ DONE — `durable-worker 0.6.0` on PyPI

Released via `.github/workflows/release-python.yml` (tag-triggered — NOT changesets; changesets only does the npm packages). Bumped `0.5.0 → 0.6.0` in `pyproject.toml` + `__init__.py`, pushed tag `durable-worker-v0.6.0` → workflow published (verified `200 OK` upload + the package live at https://pypi.org/project/durable-worker/0.6.0/). flip-python-db can now depend on `durable_worker>=0.6.0`.

---

## Architecture (corrected): processing is a Python-authored workflow

> The earlier draft put the handler-as-step split in flip-nestjs's `planPProcesses`. **That was wrong** — it relocates orchestration into flip-nestjs. The orchestration ("which handlers, what order") belongs to **flip-python-db**; flip-nestjs is the orchestrator of the *pipeline* and only **triggers** the proc. The polyglot workflow protocol (`docs/plans/2026-06-15-polyglot-workflows-protocol.md`, now implemented: `engine.registerRemote`, `RemoteWorkflowExecutor`, `ctx.startChild`, Python `WorkflowWorker`/`WorkflowContext`/`ctx.step`) lets flip-python-db **author a workflow**. So:

```
flip-nestjs  pipeline.workflow.ts (orchestrator)
   │  processing phase → ctx.startChild("processing", { type, baseId, taskId, context })
   ▼
flip-python-db  @workflow("processing")  (run on a Python WorkflowWorker, registered remote)
   │  for each handler in order:  ctx.step("handle_af_fleet", () => handle_af_fleet_dependent_processes(...))
   ▼                              ── each handle_* is a STEP (distinct in /durable) ──
   p-processes inside a handler step:  with sub_process(name, group=handler_name): sp.phase(...) ...
```

- For `type:"all"` the Python `processing` workflow runs **one `ctx.step` per `handle_*`** (af → mel → metadata → mvr → sched_mx → subwo → util) → the run shows N handler steps. The order lives in the Python workflow (replacing `handle_all_processes`'s sequencing).
- Inside each handler step, every p-process uses the shipped `with sub_process(...)` (run-id + phases + duration + log tagging).
- flip-nestjs stops the per-proc `ctx.call(processingStep)` loop; it just `startChild`s the Python workflow. `planPProcesses`/`processingStep` stay only for the **v1 SQS** path.

---

## Component B — flip-python-db: author the `processing` workflow

**Requires `durable_worker>=0.6.0` (Component A — released).**

**Files:**
- Create: a workflow-worker entrypoint (e.g. `app/durable_processing_workflow_worker.py`) — a `WorkflowWorker(group="<py-workflows>")` registering `@workflow("processing")`, bootstrapped with `workflows.run(redis=redis_url_from_env())`. Deploy it as its own process (k8s), separate from the existing step worker.
- Modify: `app/p_processes/process_handlers.py` — the leaf `handle_*` stay as the step bodies; the **ordering** logic from `handle_all_processes` moves into the workflow (or `handle_all_processes` is reused as a single step only for non-durable callers — decide at execution).
- Modify: `app/common/interface/p_process.py` — `PProcess.run()` wraps its body in `with sub_process(...)`.
- Test: `clients/python` patterns + `tests/test_*` (pytest).

### Task B1: `@workflow("processing")` — handlers as steps

- [ ] Author `@workflows.workflow("processing")` `def processing(ctx, data)`: read `type`/`base_id`/`task_id`/`context` from `data`; resolve the ordered handler list (for `"all"` → the 7 `handle_*` in `handle_all_processes`'s order; for a single type → the one handler). For each handler, `ctx.step(f"handle_{name}", lambda h=handler: h(eng, base_id, task_id))`. Return the merged context (what `processingStep` returned before — `{context}` for the COMPLETE_PHASE merge).

  > IMPORTANT — determinism: `ctx.step` bodies run on the worker and are checkpointed; put ALL the DB/p-process work inside the `ctx.step` body (never in the workflow function's top-level replay path). The handler order must be deterministic across replays (a static list keyed by `type`).
  > IMPORTANT — confirm the exact ordered handler set from `handle_all_processes` (af/mel/metadata/mvr/sched_mx/subwo/util) and how `eng` (the DB engine) is obtained inside a workflow worker (the step body needs it — thread it via the worker, not the workflow input).

- [ ] Tests: drive `WorkflowWorker.process_task` (pure, transport-free) with a fake history; assert that `type:"all"` emits one `recordStep`/`call` per handler in order, and that a single type emits one. (Mirror `clients/python/tests/test_workflow.py`.)

### Task B2: `PProcess.run()` uses `with sub_process(...)`

- [ ] Wrap the run body in `with sub_process(self.__class__.__name__, group=handler_name, id=process_run_id) as sp:` (reuse the EXISTING `process_run_id` + `handler_name`). Inside: `sp.phase("validating")`; validation failure → `sp.skip("; ".join(errors)); return`; `sp.phase("processing")`; clean exit auto-emits `ok`+durationMs; exception auto-emits `failed`+re-raises. Drop the manual `set_current_process`/`emit_subprocess` calls. Keep the v1 SQS lifecycle sends unchanged (they feed the v1 dashboard, still on for now).
- [ ] To keep the existing `elapsed_ms()` duration, pass it via `sp.skip(..., data={"durationMs": elapsed_ms()})` (the CM preserves a caller-supplied `durationMs`).
- [ ] Tests (`tests/test_observable.py` style under a fake durable step): assert events = phase `validating`, phase `processing`, terminal `ok`, all sharing `subId == process_run_id`, `group == handler_name`; plus validation-failure→`skipped` and exception→`failed`.

### Task B3: Run + deploy the workflow worker

- [ ] Add the process entrypoint + k8s deployment for the `processing` workflow worker (group must match `engine.registerRemote` in Component C). Bump `durable_worker>=0.6.0`.

---

## Component C — flip-nestjs: register the remote workflow + trigger it

### Task C1: Register `processing` as a remote workflow

- [ ] In the durable module setup, `engine.registerRemote("processing", <version>, { group: "<py-workflows>", executor: new RemoteWorkflowExecutor(transport) })` so the engine dispatches the `processing` workflow to the Python workflow-worker group. (Match the group to Component B's `WorkflowWorker(group=...)`.)

### Task C2: Trigger from the pipeline workflow; drop the per-proc loop

- [ ] In `src/durable/pipeline.workflow.ts`, replace the processing-phase loop:
  ```ts
  const plan = this.fileUpload.planPProcesses(type, baseId, taskId, this.processingContext(config));
  for (const body of plan) { const { context } = await ctx.call(processingStep, body); contexts.push(context); }
  ```
  with a single child-workflow trigger:
  ```ts
  const { context } = await ctx.startChild("processing", {
    type, baseId, taskId, ...this.processingContext(config),
  });
  ```
  (confirm `startChild`'s return shape — it awaits the child run's output; adapt the COMPLETE_PHASE merge `recordProcessingContext` to consume it). The handler steps now live in the child `processing` run (linked parent→child in `/durable`).
- [ ] `planPProcesses` + `processingStep` remain ONLY for the v1 SQS path (`startPProcesses`). Don't delete them.
- [ ] Verify cancellation: cancelling the parent pipeline run cancels the child (engine-owned); confirm in `/durable`.
- [ ] Bump `@dudousxd/nestjs-durable-*` to the released versions; `pnpm build → codegen → typecheck:inertia`.

> **Open decision (resolve at execution):** the child-run model means `/durable` shows processing as a linked child run (its own id) with N handler steps — vs. the current single pipeline run. Confirm that's the desired dashboard shape, or whether the pipeline workflow itself should move to Python (then it's one run). Default: child run via `startChild` (smallest change, keeps the TS pipeline as orchestrator).

---

## Self-Review

**Spec coverage** (against the design `2026-06-15-extensible-subprocess-lifecycle.md`):
- Run identity per p-process → reuse existing `process_run_id` as the `sub_process` id (B2). ✓
- Open `group` = handler → `handler_name` (B2); the handler-step (B1) is also the handler boundary. ✓
- Open phases (validating/processing) + terminal closed status → `sub_process.phase()` + auto-terminal (B2); the SDK provides it (A, shipped). ✓
- Discrete live events → phases stream via the step event channel (dashboard merges `step.progress`). ✓
- `handle_*` as a step + ordering owned by flip-python-db → the Python `@workflow("processing")` (B1). ✓
- Python SDK ergonomic `sub_process` + flat `sub_event` → A (released 0.6.0). ✓
- Double-dispatch out of scope → stated. ✓

**Placeholder scan:** Two items are deliberate re-verify-at-execution notes, not vague TODOs: (1) the exact ordered `handle_*` set from `handle_all_processes`, and (2) how `eng`/`startChild` return shapes wire up — both must be read fresh against the live flip-python-db / engine code. No "TBD" left.

**Type/name consistency:** `sub_process(name, *, group?, id?)` + `sub_event(id, name, group?, phase?, status?, ...)` (Python A, shipped) emit camelCase `subId`/`group`/`phase`/`name`/`status` matching the dashboard `StepEvent`. `process_run_id` → `subId` → `SubProcess.id`. `handler_name` → `group`. The Python `@workflow("processing")` group name MUST match `engine.registerRemote("processing", …, { group })` (C1) and the `WorkflowWorker(group=…)` (B).

**Open items to resolve at execution (not blockers, but verify):**
1. The exact ordered `handle_*` set + how the DB `eng` reaches a `ctx.step` body inside the workflow worker.
2. `ctx.startChild` return shape (child output) → adapt the COMPLETE_PHASE context merge in `pipeline.workflow.ts`.
3. The child-run dashboard shape decision (processing as a linked child run vs moving the whole pipeline to Python) — see the open decision under Component C.
4. Cancellation cascade parent→child run in `/durable`.
