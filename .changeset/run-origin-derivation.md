---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable': minor
---

Stamp every run with the package that declared its workflow.

`WorkflowRun` gains `origin?: string` and `RunQuery` gains an `origin` predicate, so a deployment can
finally answer "which lib produced this run" — the agent framework, a catalog pipeline, the app
itself. It sits next to `namespace` and is stamped the same way: at creation, from the registration,
never from `StartOptions`. Nothing a caller passes to `start` can make its run claim another lib's
name, because origin describes the registered code, not whoever pressed the button.

It is DERIVED, because the alternative does not work. `@Workflow({ tags })` is the only thing that
already resembles this and it is voluntary, so it is wrong in the field the moment one lib forgets: a
facet built on tags lists the two libs that opted in and implies the other three are not running,
which is worse than shipping no facet. So `@Workflow` captures the file it is being applied in — the
one moment we are provably executing inside the declaring module — and `WorkflowRegistrar` resolves
that file to the nearest enclosing `package.json` name at registration. A lib that has never heard of
this feature is attributed anyway, and there is nothing for it to forget.

`undefined` means UNKNOWN, never "the app". Runs created before this field existed have none; so do
registration paths that carry none (`registerRemote`, convention routing, a synthesized remote
child), and any workflow whose declaring package could not be resolved with confidence — a runtime
without `Error.captureStackTrace`, a frame that is not a real file, no named `package.json` above it.
Those are named in a single boot warning rather than given a plausible-looking default, because an
origin filter that quietly drops runs looks exactly like runs that never happened. A UI facet over
`RunQuery.origin` has to keep an "all origins" option for the same reason: unattributed runs match no
origin value at all.
