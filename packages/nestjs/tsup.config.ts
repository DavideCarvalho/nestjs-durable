// Decorator package: NestJS DI (@Injectable/@Module/@Inject/@Optional) relies on
// emitDecoratorMetadata — without `design:paramtypes`, constructor-injected params collapse to
// `Object` and DI breaks. The shared config transpiles via SWC so that metadata survives the dual
// ESM+CJS emit. See scripts/tsup-decorator.mjs.
import { decoratorDualConfig } from '../../scripts/tsup-decorator.mjs';

export default decoratorDualConfig(
  [
    '@dudousxd/durable-worker',
    '@dudousxd/nestjs-durable-core',
    '@dudousxd/nestjs-context',
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/event-emitter',
    'class-transformer',
    'class-validator',
    'reflect-metadata',
    'rxjs',
    'zod',
    '@nestjs/workflows',
    '@dudousxd/nestjs-durable-workflows-gateway',
    '@nestjs/outbox',
  ],
  // `./migrate-from-nestjs-workflows` and `./outbox` are their own entries, so their optional peers
  // (`@nestjs/workflows` + the workflows gateway, `@nestjs/outbox`) load only for importers of that
  // subpath. `./outbox` imports nothing from the main entry (only core and the peer), so no class
  // is bundled twice.
  {
    entry: {
      index: 'src/index.ts',
      'migrate-from-nestjs-workflows': 'src/migrate-from-nestjs-workflows/index.ts',
      outbox: 'src/outbox/index.ts',
    },
  },
);
