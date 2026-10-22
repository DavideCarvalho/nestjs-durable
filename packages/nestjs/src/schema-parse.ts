import { FatalError, type StandardSchemaV1 } from '@dudousxd/nestjs-durable-core';
import type { z } from 'zod';

/** A class-validator DTO class — validated with the same `plainToInstance` + `validate` NestJS's
 *  `ValidationPipe` runs. */
export type DtoClass = new (...args: any[]) => object;

/**
 * What `@Workflow({ input, output })` and `@Step({ input, output })` accept: a **Standard Schema**
 * (https://standardschema.dev — zod 3.24+, valibot, arktype, …) or a **class-validator DTO class**.
 * The two are told apart at runtime: a value with a `~standard` property is a Standard Schema, a
 * constructor is a DTO. A zod schema older than 3.24 (no `~standard`) still works through its `parse`.
 */
export type IoSchema = StandardSchemaV1 | DtoClass | z.ZodType;

/** Parses a value against a schema: resolves the schema's output (coerced/transformed), or throws. */
export type Parser = (value: unknown) => Promise<unknown>;

/**
 * Build a {@link Parser} for `schema`. A failure throws a {@link FatalError} — retrying cannot fix a
 * value that does not match its schema — with `code` (`invalid_input` / `invalid_output`, so a
 * dashboard, an alert or an `onError` route can tell it apart) and the schema's issues as `details`.
 * `label` names what was being checked (`workflow "checkout" input`) in the message.
 */
export function schemaParser(schema: IoSchema, kind: 'input' | 'output', label: string): Parser {
  const code = kind === 'input' ? 'invalid_input' : 'invalid_output';
  if (isStandardSchema(schema)) {
    return async (value) => {
      const result = await schema['~standard'].validate(value);
      if (result.issues) {
        const issues = result.issues.map((i) => ({
          message: i.message,
          ...(i.path ? { path: i.path.map((p) => String(typeof p === 'object' ? p.key : p)) } : {}),
        }));
        throw new FatalError(`invalid ${label}: ${formatIssues(issues)}`, code, issues);
      }
      return result.value;
    };
  }
  if (isZodLike(schema)) {
    // zod < 3.24: no `~standard`, but `safeParse` reports the same issues.
    return async (value) => {
      const result = schema.safeParse(value);
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({
          message: i.message,
          path: i.path.map(String),
        }));
        throw new FatalError(`invalid ${label}: ${formatIssues(issues)}`, code, issues);
      }
      return result.data;
    };
  }
  if (typeof schema === 'function') return classValidatorParser(schema, code, label);
  throw new Error(
    `${label}: expected a Standard Schema (zod, valibot, …) or a class-validator DTO class`,
  );
}

/**
 * The class-validator path. `class-validator` and `class-transformer` are optional peers (only needed
 * if a DTO class is used), so they are reached through a dynamic `import()`: a static import would
 * resolve them for every consumer of the package, and a `require()` cannot work at all in the ESM
 * build. That defers the "peer missing" error to the first value parsed — the only moment the peers
 * are actually needed.
 */
function classValidatorParser(cls: DtoClass, code: string, label: string): Parser {
  return async (value) => {
    let cv: any;
    let ct: any;
    try {
      cv = await import('class-validator');
      ct = await import('class-transformer');
    } catch {
      throw new Error(
        `${label} uses a class-validator DTO, which needs the optional peers "class-validator" and "class-transformer" — install them, or use a Standard Schema (zod, valibot, …) instead.`,
      );
    }
    // A DTO describes an object. class-validator crashes on `null`/`undefined` (a bare TypeError) and
    // reports nothing useful for a string or an array (which `plainToInstance` turns into an array of
    // instances), so anything else is rejected here, on the same coded contract as a failed check.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      const got = value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
      const message = `expected an object, got ${got}`;
      throw new FatalError(`invalid ${label}: ${message}`, code, [{ message }]);
    }
    const instance = ct.plainToInstance(cls, value);
    const errors = await cv.validate(instance, { whitelist: true });
    if (errors.length > 0) {
      const issues = errors.map((e: any) => ({
        message: Object.values(e.constraints ?? { _: `${e.property} is invalid` }).join(', '),
        path: [String(e.property)],
      }));
      // class-validator's messages already name the property (`orderId must be a string`).
      const message = issues.map((i: { message: string }) => i.message).join('; ');
      throw new FatalError(`invalid ${label}: ${message}`, code, issues);
    }
    return instance;
  };
}

function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  return (
    (typeof schema === 'object' || typeof schema === 'function') &&
    schema !== null &&
    '~standard' in schema
  );
}

interface ZodLike {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | {
        success: false;
        error: { issues: { message: string; path: (string | number)[] }[] };
      };
}

function isZodLike(schema: unknown): schema is ZodLike {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    typeof (schema as { safeParse?: unknown }).safeParse === 'function'
  );
}

function formatIssues(issues: { message: string; path?: string[] }[]): string {
  return issues
    .map((i) => (i.path && i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}
