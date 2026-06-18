// Decorator package: TypeORM entities (@Entity/@Column) rely on emitDecoratorMetadata for column
// type inference (e.g. `@Column() createdAt!: Date`). The shared config transpiles via SWC so that
// metadata survives the dual ESM+CJS emit. See scripts/tsup-decorator.mjs.
import { decoratorDualConfig } from '../../scripts/tsup-decorator.mjs';

export default decoratorDualConfig([
  '@dudousxd/nestjs-durable-core',
  'typeorm',
  'reflect-metadata',
]);
