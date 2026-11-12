/** Carries whether the durable tools register into the dev-tools slot (`options.devTools`). */
export const DASHBOARD_DEV_TOOLS: symbol = Symbol('DASHBOARD_DEV_TOOLS');

/** DI token carrying the UI mount base (e.g. `/durable`). */
export const DASHBOARD_BASE_PATH: symbol = Symbol('DASHBOARD_BASE_PATH');
/** DI token carrying the JSON API base the SPA fetches from (e.g. `/api/durable`). */
export const DASHBOARD_API_PATH: symbol = Symbol('DASHBOARD_API_PATH');
