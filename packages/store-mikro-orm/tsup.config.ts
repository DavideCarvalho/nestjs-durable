// Decorator package: MikroORM entities (@Entity/@Property/@PrimaryKey) rely on emitDecoratorMetadata
// for property type inference. The shared config transpiles via SWC so that metadata survives the
// dual ESM+CJS emit. See scripts/tsup-decorator.mjs.
import { decoratorDualConfig } from '../../scripts/tsup-decorator.mjs';

export default decoratorDualConfig([
  '@dudousxd/nestjs-durable-core',
  '@mikro-orm/core',
  'reflect-metadata',
]);
