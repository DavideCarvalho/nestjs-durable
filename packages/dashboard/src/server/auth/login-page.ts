/**
 * Shared HTML shell for the `dashboardAuth` server-rendered pages (the Mode B login page below and
 * `renderSessionRequiredPage`'s Mode A instruction page) — same dark zinc card, mono type, emerald
 * accent as `@dudousxd/nestjs-agent`'s dashboard login page, so every auth-adjacent page in this
 * family looks like one product. `content` is placed inside the `.card` div verbatim, so a caller
 * needing its own `<script>` (see `renderLoginPage`) can simply include it in `content` — a
 * `<script>` renders identically whether it's the div's last child or a body-level sibling.
 *
 * `content` is always caller-controlled static markup, never user input reflected into the page,
 * so this sidesteps HTML-escaping entirely.
 */
function page(content: string, title = 'Durable'): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #09090b;
    color: #e4e4e7;
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    padding: 16px;
  }
  .card {
    width: 100%;
    max-width: 384px;
    border: 1px solid #27272a;
    background: #18181b;
    border-radius: 8px;
    padding: 32px;
    box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.5);
  }
  .brand {
    margin: 0 0 24px;
    text-align: center;
    font-size: 18px;
    font-weight: 600;
    color: #34d399;
  }
  h1 {
    margin: 0 0 12px;
    font-size: 16px;
    font-weight: 600;
    color: #f4f4f5;
  }
  p { margin: 0 0 16px; color: #a1a1aa; }
  form { display: flex; flex-direction: column; gap: 16px; }
  label { display: flex; flex-direction: column; gap: 6px; }
  .field-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #71717a;
  }
  input {
    border-radius: 4px;
    border: 1px solid #3f3f46;
    background: #09090b;
    color: #f4f4f5;
    padding: 8px 12px;
    font: inherit;
    outline: none;
  }
  input:focus { border-color: rgb(52 211 153 / 0.6); }
  #error {
    display: none;
    margin: 0;
    font-size: 12px;
    color: #fb7185;
  }
  button {
    margin-top: 8px;
    border-radius: 4px;
    border: 1px solid rgb(52 211 153 / 0.4);
    background: rgb(52 211 153 / 0.1);
    color: #6ee7b7;
    padding: 8px 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: rgb(52 211 153 / 0.2); }
  button:disabled { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
  <div class="card">
    ${content}
  </div>
</body>
</html>`;
}

/**
 * The built-in `dashboardAuth` login page (`GET <basePath>/login`, Mode B). Deliberately a small,
 * dependency-free, hand-authored HTML page — NOT part of the bundled React SPA — so gating the
 * dashboard shell doesn't require rebuilding or extending the Vite bundle with a new route/screen.
 *
 * `returnTo` and any error state are read CLIENT-SIDE from `location.search` (never server-echoed
 * into the HTML), so this function's only per-request-ish input is `basePath` — a developer-
 * controlled config value, not user input — and the page body is otherwise a static template.
 *
 * The submit flow (this page POSTs JSON via `fetch` and follows the JSON `redirectTo` it gets
 * back, rather than a classic form POST + server redirect) is why the markup keeps its own
 * `<script>` rather than adopting agent-dashboard's plain `<form method="post">`.
 */
export function renderLoginPage(basePath: string): string {
  const loginAction = `${basePath}/login`;
  const defaultReturnTo = basePath;
  return page(
    `<p class="brand">Durable</p>
    <form id="login-form" autocomplete="on">
      <label>
        <span class="field-label">Username</span>
        <input id="username" name="username" type="text" autocomplete="username" required autofocus />
      </label>
      <label>
        <span class="field-label">Password</span>
        <input id="password" name="password" type="password" autocomplete="current-password" />
      </label>
      <p id="error" role="alert">Invalid username or password.</p>
      <button id="submit" type="submit">Sign in</button>
    </form>
<script>
(function () {
  var LOGIN_ACTION = ${JSON.stringify(loginAction)};
  var DEFAULT_RETURN_TO = ${JSON.stringify(defaultReturnTo)};
  var params = new URLSearchParams(window.location.search);
  var errorBox = document.getElementById('error');
  if (params.get('error')) errorBox.style.display = 'block';

  function sameOriginReturnTo(value) {
    if (typeof value !== 'string' || value === '') return DEFAULT_RETURN_TO;
    if (value.charAt(0) !== '/' || value.charAt(1) === '/' || value.indexOf('://') !== -1) {
      return DEFAULT_RETURN_TO;
    }
    return value;
  }

  var form = document.getElementById('login-form');
  var submitButton = document.getElementById('submit');
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    submitButton.disabled = true;
    errorBox.style.display = 'none';
    var returnTo = sameOriginReturnTo(params.get('returnTo'));
    fetch(LOGIN_ACTION, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
        returnTo: returnTo,
      }),
    })
      .then(function (response) {
        if (!response.ok) throw new Error('unauthorized');
        return response.json();
      })
      .then(function (data) {
        window.location.href = data.redirectTo || DEFAULT_RETURN_TO;
      })
      .catch(function () {
        errorBox.style.display = 'block';
        submitButton.disabled = false;
      });
  });
})();
</script>`,
    'Sign in — Durable',
  );
}

/**
 * Mode-A-only shell (`GET <basePath>/login` never renders under Mode A — this is what the page
 * guard serves in its place, see `session-required.exception.ts`): there is no form here because
 * the host mints the session. Mirrors `renderLoginPage`'s markup so the two pages look like one
 * product. `basePath` isn't otherwise interpolated (nothing here links back to it), but the param
 * mirrors `renderLoginPage`'s signature for symmetry between the two dashboardAuth pages.
 */
export function renderSessionRequiredPage(basePath: string): string {
  return page(
    `<h1>Open this console from your application</h1>
     <p>Your session is minted by the host app. Use its console launcher to sign in, then reload.</p>
     <button type="button" onclick="location.reload()">Retry</button>`,
  );
}
