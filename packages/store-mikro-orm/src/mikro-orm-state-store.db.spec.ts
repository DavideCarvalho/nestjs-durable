import {
  type StateStoreContext,
  StateStoreUnavailableError,
  runStateStoreContract,
} from '@dudousxd/nestjs-durable-testing';
import { MikroORM as MySqlMikroORM } from '@mikro-orm/mysql';
import { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe } from 'vitest';
import { makeMikroOrmStoreFactory } from './conformance';

/**
 * Real-engine matrix for the MikroORM adapter: the SHARED cross-store contract against Postgres and
 * MySQL (testcontainers). Validates the dialect-aware `ensureSchema` (`updateSchema`), the raw EXISTS
 * search-attribute pushdown (whose identifier quoting + column-name resolution are driver-specific),
 * and the JSON-column tag LIKE (which needs a per-dialect text cast) against the real engines. Run
 * with `pnpm test:db`. Skips cleanly when Docker is unavailable or `SKIP_TESTCONTAINERS` is set.
 */

const CONTAINER_TIMEOUT = 180_000;
const skipped = !!process.env.SKIP_TESTCONTAINERS;

type Factory = ReturnType<typeof makeMikroOrmStoreFactory>;

// --- Postgres ---------------------------------------------------------------------------------

let pg: StartedPostgreSqlContainer | undefined;
let pgError: unknown;
let pgFactory: Factory | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    pg = await new PostgreSqlContainer('postgres:16-alpine').start();
    pgFactory = makeMikroOrmStoreFactory((options) => PostgresMikroORM.init(options), {
      host: pg.getHost(),
      port: pg.getPort(),
      user: pg.getUsername(),
      password: pg.getPassword(),
      dbName: pg.getDatabase(),
    });
  } catch (err) {
    pgError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await pg?.stop();
});

describe('MikroORM (Postgres) [real engine]', () => {
  runStateStoreContract('MikroORM (Postgres)', async (): Promise<StateStoreContext> => {
    if (skipped) throw new StateStoreUnavailableError('SKIP_TESTCONTAINERS set');
    if (pgError)
      throw new StateStoreUnavailableError(
        `Postgres testcontainer unavailable (is Docker running?): ${String(pgError)}`,
      );
    if (!pgFactory) throw new StateStoreUnavailableError('Postgres container not started');
    return pgFactory();
  });
});

// --- MySQL ------------------------------------------------------------------------------------

let mysql: StartedMySqlContainer | undefined;
let mysqlError: unknown;
let mysqlFactory: Factory | undefined;

beforeAll(async () => {
  if (skipped) return;
  try {
    mysql = await new MySqlContainer('mysql:8.0').start();
    mysqlFactory = makeMikroOrmStoreFactory((options) => MySqlMikroORM.init(options), {
      host: mysql.getHost(),
      port: mysql.getPort(),
      user: mysql.getUsername(),
      password: mysql.getUserPassword(),
      dbName: mysql.getDatabase(),
    });
  } catch (err) {
    mysqlError = err;
  }
}, CONTAINER_TIMEOUT);

afterAll(async () => {
  await mysql?.stop();
});

describe('MikroORM (MySQL) [real engine]', () => {
  runStateStoreContract('MikroORM (MySQL)', async (): Promise<StateStoreContext> => {
    if (skipped) throw new StateStoreUnavailableError('SKIP_TESTCONTAINERS set');
    if (mysqlError)
      throw new StateStoreUnavailableError(
        `MySQL testcontainer unavailable (is Docker running?): ${String(mysqlError)}`,
      );
    if (!mysqlFactory) throw new StateStoreUnavailableError('MySQL container not started');
    return mysqlFactory();
  });
});
