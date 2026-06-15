type ClassCtor = new (...args: any[]) => object;

/**
 * Build a `validateInput` from a class-validator DTO class — the same `plainToInstance` + `validate`
 * NestJS runs in controllers. `class-validator` and `class-transformer` are lazy-required optional
 * peers (only needed if you use `@Workflow({ inputSchema })`), so they stay out of the type graph.
 */
export function classValidatorInput(cls: ClassCtor): (input: unknown) => Promise<void> {
  let cv: any;
  let ct: any;
  try {
    cv = require('class-validator');
    ct = require('class-transformer');
  } catch {
    throw new Error(
      '@Workflow({ inputSchema }) needs the optional peers "class-validator" and "class-transformer" — install them, or pass a `validateInput` function instead.',
    );
  }
  return async (input: unknown) => {
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
