import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Derives a workflow's **origin** — the npm package that declared it (`@dudousxd/nestjs-agent`, the
 * host app's own `package.json` `name`, …) — so every run can say which lib produced it (see
 * {@link import('@dudousxd/nestjs-durable-core').WorkflowRun.origin}).
 *
 * WHY IT IS DERIVED AND NOT DECLARED: anything a lib has to opt into (a `@Workflow({ tags })`
 * convention, a registry of known packages) is already wrong in the field the day a lib forgets, and
 * a facet that lists two of the five libs actually running is worse than no facet at all. So the only
 * acceptable input is one the lib cannot fail to provide: the file it declared its `@Workflow` class
 * in. That file is captured by {@link declaringFile} at decoration time — the one moment we are
 * guaranteed to be executing inside the declaring module — and mapped here to the nearest enclosing
 * `package.json` `name`.
 *
 * WHY NOT THE NEST MODULE: the `InstanceWrapper` a `DiscoveryService` scan hands back does name the
 * module a provider came from (`wrapper.host.metatype`), but a module class is just a class — it
 * carries no file location, and the app's own module is a perfectly normal place to register a lib's
 * workflow, which would then be attributed to the app. The declaring file of the `@Workflow` class is
 * both available and strictly more precise, so the wrapper is used only to reach that class.
 *
 * EVERY step here can fail, and each failure yields `undefined` (= unknown) rather than a guess:
 *   - a runtime without V8's `Error.captureStackTrace`, or an app that set `Error.stackTraceLimit = 0`
 *   - a declaring frame that is not a real file (`node:` internals, `eval`, `<anonymous>`) — notably a
 *     single-file bundle can also collapse several packages into one file, and where the file IS real
 *     but shared, the origin will be the bundle's package: that is the one shape this cannot detect
 *   - no `package.json` carrying a `name` anywhere above the file
 * `WorkflowRegistrar` reports the workflows that came back unattributed once, at boot.
 */

/** The file each decorated class was declared in, keyed by the class itself. */
const declaringFileByClass = new WeakMap<object, string>();

/** Memoized directory → owning package name (or `undefined` when the walk found none). */
const packageNameByDir = new Map<string, string | undefined>();

type AnyFunction = (...args: never[]) => unknown;

/**
 * The absolute path of the file that is calling `boundary` right now — i.e. the file whose top level
 * is applying a decorator, when called from inside that decorator's factory. `boundary` is clipped
 * off the captured stack (`Error.captureStackTrace`'s second argument), so the first remaining frame
 * is the caller's, with no frame counting to go stale when this file is refactored.
 *
 * Returns `undefined` on any runtime that does not give us a usable frame.
 */
export function declaringFile(boundary: AnyFunction): string | undefined {
  const capture = Error.captureStackTrace;
  if (typeof capture !== 'function') return undefined;
  const holder: { stack?: string } = {};
  capture(holder, boundary);
  return topFrameFile(holder.stack);
}

/** Records the file `target` was declared in, so {@link originOfClass} can resolve it later. */
export function rememberDeclaringFile(target: object, file: string | undefined): void {
  if (file) declaringFileByClass.set(target, file);
}

/**
 * The package that declared `target`, or `undefined` if it cannot be resolved with confidence.
 *
 * Walks the prototype chain, matching `Reflect.getMetadata`'s inheritance: a subclass that inherits
 * its `@Workflow` metadata from a decorated base also inherits that base's origin, because the base
 * is where the decorated body was declared.
 */
export function originOfClass(target: unknown): string | undefined {
  for (
    let ctor: unknown = target;
    typeof ctor === 'function' || (typeof ctor === 'object' && ctor !== null);
    ctor = Object.getPrototypeOf(ctor)
  ) {
    const file = declaringFileByClass.get(ctor);
    if (file) return packageNameFor(file);
  }
  return undefined;
}

/**
 * The package that declared the workflow behind a discovered provider. Structurally typed against
 * Nest's `InstanceWrapper` (the shape `DiscoveryService.getProviders()` returns) so this package does
 * not deep-import an internal Nest path: `metatype` is the registered class, and `instance.constructor`
 * covers a provider whose metatype is absent (a `useValue`/factory-built instance of a decorated class).
 */
export function originOfProvider(wrapper: {
  metatype?: unknown;
  instance?: unknown;
}): string | undefined {
  const fromMetatype = originOfClass(wrapper.metatype);
  if (fromMetatype) return fromMetatype;
  const instance = wrapper.instance;
  if (typeof instance !== 'object' || instance === null) return undefined;
  return originOfClass(instance.constructor);
}

/**
 * The `name` of the nearest `package.json` at or above `file`'s directory. For a lib this is the
 * installed package (`…/node_modules/@scope/lib/dist/index.cjs` → `@scope/lib`, pnpm's nested layout
 * included); for a workflow written in the app it is the app's own name. Memoized per directory —
 * the walk hits the filesystem once per distinct directory, not once per workflow.
 */
function packageNameFor(file: string): string | undefined {
  const start = dirname(file);
  const visited: string[] = [];
  let dir = start;
  for (;;) {
    if (packageNameByDir.has(dir)) {
      const cached = packageNameByDir.get(dir);
      for (const seen of visited) packageNameByDir.set(seen, cached);
      return cached;
    }
    visited.push(dir);
    const name = readPackageName(join(dir, 'package.json'));
    if (name !== undefined) {
      for (const seen of visited) packageNameByDir.set(seen, name);
      return name;
    }
    const parent = dirname(dir);
    // `dirname('/')` is `'/'` — the filesystem root is the end of the walk.
    if (parent === dir) {
      for (const seen of visited) packageNameByDir.set(seen, undefined);
      return undefined;
    }
    dir = parent;
  }
}

/** The `name` field of a `package.json`, or `undefined` if it is missing, unreadable or unnamed. */
function readPackageName(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed package.json is not ours to fail on — keep walking up.
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const name = parsed.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The file named by the FIRST frame of a captured stack. Deliberately only the first: with the
 * capture boundary clipped, frame 0 IS the declaring site, and falling through to a deeper frame
 * when it is unparseable would attribute the workflow to whatever happened to be further up the
 * stack (the test runner, Nest's loader) — a confident-looking wrong answer.
 */
function topFrameFile(stack: string | undefined): string | undefined {
  if (typeof stack !== 'string') return undefined;
  for (const line of stack.split('\n')) {
    const frame = line.trim();
    if (!frame.startsWith('at ')) continue;
    return fileOfFrame(frame.slice(3));
  }
  return undefined;
}

/** `foo (/a/b.ts:1:2)` / `/a/b.ts:1:2` / `file:///a/b.js:1:2` → an absolute path, else `undefined`. */
function fileOfFrame(frame: string): string | undefined {
  const match = /\((.+):\d+:\d+\)$/.exec(frame) ?? /^(.+):\d+:\d+$/.exec(frame);
  const location = match?.[1];
  if (location === undefined) return undefined;
  if (location.startsWith('file://')) {
    try {
      return fileURLToPath(location);
    } catch {
      return undefined;
    }
  }
  // Anything that is not an absolute path is not a file we can resolve a package from: `node:internal/…`,
  // `<anonymous>`, `eval at …`, a bundler's virtual id.
  const absolute = location.startsWith('/') || /^[A-Za-z]:[\\/]/.test(location);
  return absolute ? location : undefined;
}
