import { beforeEach } from 'vitest';

/**
 * With `DURABLE_TEST_REQUIRE_BACKENDS` set (CI does), a case that would skip itself because its
 * backend is unreachable FAILS instead. The real-backend specs skip on a missing Docker daemon so a
 * laptop without one stays green, but in CI a container that failed to start would otherwise turn
 * the whole matrix into green no-ops. Static `it.skip`/`it.runIf` capability skips are unaffected:
 * their hooks never run.
 */
if (process.env.DURABLE_TEST_REQUIRE_BACKENDS) {
  beforeEach((ctx) => {
    ctx.skip = () => {
      throw new Error(
        'this case tried to skip because its backend is unavailable, but DURABLE_TEST_REQUIRE_BACKENDS is set',
      );
    };
  });
}
