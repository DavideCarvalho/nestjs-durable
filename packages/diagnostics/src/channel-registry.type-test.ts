/**
 * Compile-time guard for the ChannelRegistry augmentation in ./channel-registry. The augmentation
 * has no runtime effect, so it cannot be guarded by a runtime (vitest) test — only by the type
 * checker. This file is type-checked by `pnpm typecheck` (tsc includes src/**, excludes *.spec.ts)
 * and is never shipped (tsup bundles only index.ts, which does not import this file). If the
 * augmentation stops mapping ('durable', <event>) to EngineEvent, these lines fail to compile.
 */
import { emit } from '@dudousxd/nestjs-diagnostics';
import type { EngineEvent } from '@dudousxd/nestjs-durable-core';
import './channel-registry';

const sample: EngineEvent = { type: 'run.failed', runId: 'r', at: new Date() };

// Positive: the augmentation makes EngineEvent the accepted payload for every durable channel.
export function _acceptsEngineEvent(): void {
  emit('durable', 'run.failed', sample);
  emit('durable', 'step.completed', sample);
}

// Negative: a non-EngineEvent payload is rejected ONLY because the augmentation narrowed it.
// Without the augmentation, emit('durable', ...) accepts `unknown`, the number below would be
// accepted, and this directive would become an unused-directive compile error — so this line
// proves the augmentation is live and narrowing.
export function _rejectsWrongPayload(): void {
  // @ts-expect-error - payload must be EngineEvent, not a number
  emit('durable', 'run.failed', 123);
}
