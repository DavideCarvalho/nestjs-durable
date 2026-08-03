/**
 * Reading a cron expression across both cron-parser majors.
 *
 * The peer range is `^4.0.0 || ^5.0.0` and the two majors do not share an entry
 * point: v4 exports `parseExpression`, v5 replaced it with
 * `CronExpressionParser.parse`. Typing the module as
 * `typeof import('cron-parser')` pins it to whichever major is dev-installed and
 * makes the other one a compile error — which is how the scheduler shipped
 * calling only v4 while advertising both, so every v5 install failed at runtime
 * with "parser.parseExpression is not a function": a message that reads as a
 * missing dependency rather than as the wrong major.
 *
 * Deliberately NOT re-exported from `index.ts`. This is interop plumbing, not
 * public API; the spec imports it from this path directly.
 */

export interface CronOptions {
  currentDate: Date;
  tz: string;
}

export interface CronFire {
  prev(): { toDate(): Date };
}

export type ParseCron = (expr: string, options: CronOptions) => CronFire;

/**
 * Anything `Reflect.get` can read a member off.
 *
 * Admits functions as well as objects, because cron-parser v4's CommonJS export
 * *is* a function carrying `parseExpression` as a property — an object-only
 * guard rejects the very major this range exists to support.
 */
function isIndexable(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** ESM/CJS interop: a `require` can hand back the namespace with the module under `default`. */
export function unwrapDefault(module_: unknown): unknown {
  if (!isIndexable(module_)) return module_;
  if (Reflect.get(module_, 'parseExpression') !== undefined) return module_;
  if (Reflect.get(module_, 'CronExpressionParser') !== undefined) return module_;
  const inner = Reflect.get(module_, 'default');
  return inner === undefined ? module_ : inner;
}

/** v4: `parseExpression(expr, options)`. */
export function v4Entry(module_: unknown): ParseCron | undefined {
  if (!isIndexable(module_)) return undefined;
  const parse = Reflect.get(module_, 'parseExpression');
  if (typeof parse !== 'function') return undefined;
  return (expr, options) => parse.call(module_, expr, options);
}

/** v5: `CronExpressionParser.parse(expr, options)`. */
export function v5Entry(module_: unknown): ParseCron | undefined {
  if (!isIndexable(module_)) return undefined;
  const parser = Reflect.get(module_, 'CronExpressionParser');
  if (!isIndexable(parser)) return undefined;
  const parse = Reflect.get(parser, 'parse');
  if (typeof parse !== 'function') return undefined;
  return (expr, options) => parse.call(parser, expr, options);
}

/**
 * The parse entry point of whichever major is installed.
 *
 * v4 is tried first only because it is the cheaper check; a module cannot
 * present both entry points, so the order carries no meaning beyond that.
 */
export function resolveCronParse(module_: unknown): ParseCron | undefined {
  const resolved = unwrapDefault(module_);
  return v4Entry(resolved) ?? v5Entry(resolved);
}
