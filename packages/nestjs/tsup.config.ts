// Decorator package: NestJS DI (@Injectable/@Module/@Inject/@Optional) relies on
// emitDecoratorMetadata — without `design:paramtypes`, constructor-injected params collapse to
// `Object` and DI breaks. The shared config transpiles via SWC so that metadata survives the dual
// ESM+CJS emit. See scripts/tsup-decorator.mjs.
import { decoratorDualConfig } from '../../scripts/tsup-decorator.mjs';

export default decoratorDualConfig([
  '@dudousxd/nestjs-durable-core',
  '@dudousxd/nestjs-context',
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/event-emitter',
  'class-transformer',
  'class-validator',
  'reflect-metadata',
  'rxjs',
]);
