/**
 * An event another instance produced and the control plane re-delivered here. Every instance hears
 * every run's lifecycle, so a consumer that RECORDS events (Telescope, a metrics counter, a trace
 * exporter) would record each one once per pod; such consumers skip the events marked remote.
 *
 * The mark is a non-enumerable property under a registered symbol, so it never reaches a serialized
 * event and a consumer can test for it without importing this module.
 */
export const REMOTE_EVENT = Symbol.for('@dudousxd/nestjs-durable:remote-event');

export function markRemoteEvent<E extends object>(event: E): E {
  Object.defineProperty(event, REMOTE_EVENT, { value: true });
  return event;
}

/** Whether `event` was produced by another instance and re-delivered here over the control plane. */
export function isRemoteEvent(event: object): boolean {
  return (event as { [REMOTE_EVENT]?: unknown })[REMOTE_EVENT] === true;
}
