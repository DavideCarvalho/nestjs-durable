import { APP_PARAM, selectedApp } from '../client/durable-client';
import { useTopology } from './capabilities';

/** The empty choice: the console's own app. */
const LOCAL = '';

/**
 * The URL that shows `app` (`''`: the console's own app): the current page with `?app=` set or
 * removed. The hash is dropped, since a run open in one app does not exist in another.
 */
export function appHref(app: string, location: Pick<Location, 'pathname' | 'search'>): string {
  const params = new URLSearchParams(location.search);
  if (app === LOCAL) params.delete(APP_PARAM);
  else params.set(APP_PARAM, app);
  const qs = params.toString();
  return `${location.pathname}${qs ? `?${qs}` : ''}`;
}

/**
 * The app switcher of a federated console (the server's `federation` option): the console's own app
 * plus each app the viewer may see. Choosing one reloads the console on `?app=<name>`, so every
 * cached read is refetched for that app. Renders nothing on a console without federation.
 */
export function AppSelector() {
  const federation = useTopology()?.federation;
  if (!federation || federation.apps.length === 0) return null;
  const current = selectedApp() ?? LOCAL;
  return (
    <label className="flex items-center gap-1.5 text-[12px] text-dim">
      <span className="hidden sm:inline">App</span>
      <select
        aria-label="App"
        className="rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-fg"
        value={current}
        onChange={(event) => {
          window.location.assign(appHref(event.target.value, window.location));
        }}
      >
        <option value={LOCAL}>{federation.local.label}</option>
        {federation.apps.map((app) => (
          <option key={app.name} value={app.name}>
            {app.label}
          </option>
        ))}
      </select>
    </label>
  );
}
