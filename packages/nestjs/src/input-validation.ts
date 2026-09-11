type ClassCtor = new (...args: any[]) => object;

/**
 * Build a `validateInput` from a class-validator DTO class — the same `plainToInstance` + `validate`
 * NestJS runs in controllers. `class-validator` and `class-transformer` are optional peers (only
 * needed if you use `@Workflow({ inputSchema })`), so they are reached through a dynamic `import()`
 * inside the validator: a static import would resolve them for every consumer of the package, and a
 * `require()` cannot work at all in the ESM build. That defers the "peer missing" error from
 * registration to the first `start` of a workflow that declares an `inputSchema` — the only moment
 * the peers are actually needed.
 */
export function classValidatorInput(cls: ClassCtor): (input: unknown) => Promise<void> {
  return async (input: unknown) => {
    let cv: any;
    let ct: any;
    try {
      cv = await import('class-validator');
      ct = await import('class-transformer');
    } catch {
      throw new Error(
        '@Workflow({ inputSchema }) needs the optional peers "class-validator" and "class-transformer" — install them, or pass a `validateInput` function instead.',
      );
    }
    const instance = ct.plainToInstance(cls, input);
    const errors = await cv.validate(instance, { whitelist: true });
    if (errors.length > 0) {
      const message = errors
        .map((e: any) => Object.values(e.constraints ?? { _: e.property }).join(', '))
        .join('; ');
      throw new Error(`invalid input for workflow: ${message}`);
    }
  };
}
