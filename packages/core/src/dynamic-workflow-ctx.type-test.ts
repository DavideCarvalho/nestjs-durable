/**
 * Compile-time guard: every `WorkflowCtx` is usable where code asks for a narrow, NON-overloaded ctx —
 * the exported {@link DynamicWorkflowCtx}, a `Pick` of it, or a hand-written structural interface of
 * the kind a graph interpreter declares — with no `as unknown as` cast. Also guards that a `Pick` of
 * `DynamicWorkflowCtx` can be implemented by a plain object literal (a test fake). No runtime
 * assertions; checked by `pnpm typecheck` only (tsc includes src/**, excludes *.spec.ts).
 */
import type { DynamicWorkflowCtx, WorkflowCtx } from './interfaces';

declare const ctx: WorkflowCtx;
declare const typedCtx: WorkflowCtx<{ tier: string; amount: number }>;

// A WorkflowCtx IS a DynamicWorkflowCtx (and keeps its attributes generic).
export const dynamic: DynamicWorkflowCtx = ctx;
export const typedDynamic: DynamicWorkflowCtx<{ tier: string; amount: number }> = typedCtx;

// The narrow interface an interpreter writes by hand — overloaded `all`/`child` included.
interface InterpreterCtx {
  readonly runId: string;
  localStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(duration: number): Promise<void>;
  sleepUntil(when: Date | number): Promise<void>;
  waitForSignal<T>(token: string, opts?: { timeoutMs?: number }): Promise<T>;
  child<T>(workflow: string, input: unknown, options?: { childId?: string }): Promise<T>;
  all<T>(workflow: string, inputs: unknown[]): Promise<T[]>;
  startChild(workflow: string, input: unknown, options?: { childId?: string }): Promise<string>;
  step<T>(name: string, input: unknown): Promise<T>;
}
export const fromCtx: InterpreterCtx = ctx;
export const fromDynamic: InterpreterCtx = dynamic;

// A Pick of it is a plain object literal — what a test fake looks like.
export const fake: Pick<DynamicWorkflowCtx, 'runId' | 'all' | 'child' | 'localStep'> = {
  runId: 'r1',
  all: async <T>(_workflow: string, inputs: unknown[]) => inputs as T[],
  child: async <T>(_workflow: string, input: unknown) => input as T,
  localStep: (_name, fn) => fn({} as never),
};

// Negative: the dynamic forms take names, not classes/refs.
// @ts-expect-error — `child` on a DynamicWorkflowCtx is string-addressed only.
dynamic.child(class {}, {});
