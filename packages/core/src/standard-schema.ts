/**
 * Vendored subset of the Standard Schema spec (https://standardschema.dev) — the `~standard`
 * property protocol implemented by zod 3.24+, valibot, arktype, and others. Vendored (rather than
 * taken as a dependency) so core stays dependency-free at runtime: this file is types only, erased
 * entirely by the build. Source: https://github.com/standard-schema/standard-schema (MIT, Colin
 * McDonnell) — trimmed to the `StandardSchemaV1` shape this package actually consumes (drops the
 * sibling `StandardTypedV1`/`StandardJSONSchemaV1` specs the upstream package also exports).
 *
 * Used to type `@Workflow({ searchAttributes })` (see `WorkflowMeta.searchAttributes` in
 * `@dudousxd/nestjs-durable` and `SearchAttributesSchema`/`InferSearchAttributes` in `interfaces.ts`)
 * so a workflow can declare its search-attribute shape with whatever schema library it already uses,
 * without core taking a hard dependency on any of them.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  /** The Standard Schema properties interface. */
  interface Props<Input = unknown, Output = Input> {
    /** The version number of the standard. */
    readonly version: 1;
    /** The vendor name of the schema library. */
    readonly vendor: string;
    /** Validates unknown input values. */
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    /** Inferred types associated with the schema. */
    readonly types?: Types<Input, Output> | undefined;
  }

  /** The result interface of the validate function. */
  type Result<Output> = SuccessResult<Output> | FailureResult;

  /** The result interface if validation succeeds. */
  interface SuccessResult<Output> {
    /** The typed output value. */
    readonly value: Output;
    /** A falsy value for `issues` indicates success. */
    readonly issues?: undefined;
  }

  /** The result interface if validation fails. */
  interface FailureResult {
    /** The issues of failed validation. */
    readonly issues: ReadonlyArray<Issue>;
  }

  /** The issue interface of the failure output. */
  interface Issue {
    /** The error message of the issue. */
    readonly message: string;
    /** The path of the issue, if any. */
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  /** The path segment interface of the issue. */
  interface PathSegment {
    /** The key representing a path segment. */
    readonly key: PropertyKey;
  }

  /** The Standard Schema types interface. */
  interface Types<Input = unknown, Output = Input> {
    /** The input type of the schema. */
    readonly input: Input;
    /** The output type of the schema. */
    readonly output: Output;
  }

  /** Infers the input type of a Standard Schema. */
  type InferInput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['input'];

  /** Infers the output type of a Standard Schema. */
  type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema['~standard']['types']
  >['output'];
}
