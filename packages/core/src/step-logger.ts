import type { StepEvent, StepLogger } from './interfaces';

/**
 * A {@link StepLogger} that appends to `events`, stamping each line with `now()`. Shared by the
 * local-step path (`ctx.step`) and the remote-worker path (`runStepHandler`) so a step records
 * the same {@link StepEvent} shape wherever it runs — the TypeScript twin of the Python SDK's
 * `StepContext`.
 */
export function createStepLogger(events: StepEvent[], now: () => number): StepLogger {
  const push = (level: StepEvent['level'], message: string, data?: unknown) =>
    events.push({ at: now(), level, message, ...(data === undefined ? {} : { data }) });
  return {
    debug: (m, d) => push('debug', m, d),
    info: (m, d) => push('info', m, d),
    warn: (m, d) => push('warn', m, d),
    error: (m, d) => push('error', m, d),
    sub: (name, status, message, data) =>
      events.push({
        at: now(),
        level: status === 'failed' ? 'error' : status === 'skipped' ? 'warn' : 'info',
        message: message ?? name,
        name,
        status,
        ...(data === undefined ? {} : { data }),
      }),
    subEvent: (e) =>
      events.push({
        at: now(),
        level: e.status === 'failed' ? 'error' : e.status === 'skipped' ? 'warn' : 'info',
        message: e.message ?? e.phase ?? e.name,
        subId: e.id,
        name: e.name,
        ...(e.group === undefined ? {} : { group: e.group }),
        ...(e.phase === undefined ? {} : { phase: e.phase }),
        ...(e.status === undefined ? {} : { status: e.status }),
        ...(e.data === undefined ? {} : { data: e.data }),
      }),
  };
}
