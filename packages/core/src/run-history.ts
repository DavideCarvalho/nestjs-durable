/**
 * Format marker of a run-history replay fixture (`{ version, run, checkpoints }`). Written by the
 * testing kit's `serializeRunHistory` and the CLI's `durable export`, checked by `parseRunHistory`.
 * Lives in core so both writers (which already depend on core, not on each other) share one value.
 * Bump it only when the fixture shape changes incompatibly.
 */
export const RUN_HISTORY_FIXTURE_VERSION = 1;
