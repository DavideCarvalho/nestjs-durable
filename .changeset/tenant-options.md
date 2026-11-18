---
"@dudousxd/nestjs-durable-core": minor
"@dudousxd/nestjs-durable": minor
"@dudousxd/durable-worker": minor
---

A `DurableModule` tenant (a `connection`, no `store`) now gets its `@Workflow` options, dead-letter handlers, interceptors, signals and events through the control plane.

- **`@Workflow` options.** A tenant start validates the input (`input` schema, `validateInput`) before anything is sent, and evaluates the `singleton` key and the default `concurrency` quota; the start-run carries them (`StartRunMessage.singleton`). The control plane stamps `singleton:<partition>/<key>` and admits the run like a local singleton. Workers announce static `tags`, `executionTimeout` and the singleton `limit` (`WorkflowRegistration.options`); a control plane serving the workflow by convention merges the tags, sweeps the timeout and admits up to the limit. Per-start options beat the workflow's, a registration on the control plane beats anything announced, and when replicas disagree the worker that started last wins. A tenant schedule of a singleton workflow class announces its evaluated key (`AnnouncedSchedule.singleton`).
- **`@DeadLetter` handlers.** A tenant's inline `@DeadLetter()` method is served as `<name>.dlq` and announced as the workflow's route (`WorkflowRegistration.deadLetter`, else its `deadLetterWorkflow`, else the module default). When a run dead-letters on the control plane, the control plane starts it in the run's partition as `dlq:<runId>`, on the tenant (`WorkflowEngine.announcedDeadLetter`); its own default stands aside for that workflow.
- **Interceptors and entities.** `@StepInterceptor()` providers wrap the steps a tenant's workers run (`DurableWorkerRuntime.use`, `StepWorker.use`). An `@Entity` on a tenant fails at boot: its state and handlers live in the engine that owns the store.
- **`signal`, `signalWithStart`, `publishEvent` on a tenant** are run requests to the control plane (new `signalWithStart` and `publishEvent` verbs; `signal` takes `opts`), scoped to the tenant's partition: a signal is delivered only to a run of the partition and never buffered; `signalWithStart` starts the run in the partition and buffers its signal only on a token that contains the run id; `publishEvent` starts the app's own subscribers and resumes the partition's waiting runs (`WorkflowEngine.signalWithStartForTenant`, `publishEventForTenant`).
