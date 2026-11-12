import 'reflect-metadata';
import { type ExecutionContext, Inject, Injectable, Module } from '@nestjs/common';
import { ModuleRef, NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { resolveConsoleAuthorize } from './console-authorize.js';

@Injectable()
class Dependency {
  readonly value = 'injected';
}

@Injectable()
class ArrowAuthorizer {
  constructor(@Inject(Dependency) readonly dependency: Dependency) {}
  // An instance-property arrow function: not on the prototype.
  authorize = (_context: ExecutionContext) => this.dependency?.value === 'injected';
}

@Module({ providers: [Dependency] })
class AppModule {}

const context = {
  getType: () => 'http',
  switchToHttp: () => ({ getRequest: () => ({ headers: {} }), getResponse: () => ({}) }),
} as unknown as ExecutionContext;

describe('class form: an arrow-function authorize property', () => {
  it('is still a class (built through DI), directly and through a lazy import', async () => {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const moduleRef = app.get(ModuleRef);
    const direct = await resolveConsoleAuthorize(ArrowAuthorizer, moduleRef);
    expect(await direct(context)).toEqual({ allowed: true });
    const lazy = await resolveConsoleAuthorize(
      async () => ({ default: ArrowAuthorizer }),
      moduleRef,
    );
    expect(await lazy(context)).toEqual({ allowed: true });
    await app.close();
  });
});
