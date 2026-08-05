import { createHash } from 'node:crypto';
import { type Context, TraceFlags, context, trace } from '@opentelemetry/api';

/**
 * The trace a run's spans hang under, DERIVED FROM THE RUN ID rather than held as a live root span.
 *
 * The obvious implementation — open a root span on `run.started`, keep it in a map, end it when the
 * run settles — cannot work for a durable workflow. A run suspends: `ctx.step` dispatches and the
 * turn unwinds, and the step body then executes minutes (or days) later, on a different turn, very
 * often in a different process. A live root span would either have to be ended at every suspension —
 * fragmenting one run into a trace per turn, so the step that failed is in a different trace from
 * the turn that dispatched it — or held open across the suspension, which pins a span object for the
 * lifetime of a workflow that is explicitly designed to wait for days.
 *
 * Hashing the run id sidesteps both. The trace id is a pure function of the run, so every turn and
 * every step of a run lands in ONE trace with no state held anywhere, and a worker in another
 * process computes the same id from the same run id — which is what makes a remotely-executed step
 * correlate with the run that dispatched it at all.
 *
 * The parent span context is marked `isRemote` because that is what it is: a reference to a trace
 * whose "root" is the run itself, not a span this process ever recorded.
 */
export function runTraceId(runId: string): string {
  // 16 bytes of hex, as the W3C trace-context spec requires. sha256 is not used as a security
  // primitive here — only as a well-distributed map from an arbitrary run id into that space.
  return createHash('sha256').update(`durable:run:${runId}`).digest('hex').slice(0, 32);
}

/** The synthetic parent span id for a run's trace — derived the same way, from a different prefix. */
function runSpanId(runId: string): string {
  return createHash('sha256').update(`durable:run-span:${runId}`).digest('hex').slice(0, 16);
}

/**
 * An OTel {@link Context} whose active span context is the run's synthetic root. Spans started
 * against it are children of the run, and Telescope's trace-context provider stamps every entry
 * recorded inside it with {@link runTraceId}.
 *
 * `TraceFlags.SAMPLED` is set deliberately: a non-sampled parent leaves the derived span
 * non-recording, and its span context would then never reach an exporter — the run would be
 * traceable in Telescope but invisible in any OTel backend, which is the confusing half-state.
 */
export function runTraceContext(runId: string, parent: Context = context.active()): Context {
  return trace.setSpanContext(parent, {
    traceId: runTraceId(runId),
    spanId: runSpanId(runId),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}
