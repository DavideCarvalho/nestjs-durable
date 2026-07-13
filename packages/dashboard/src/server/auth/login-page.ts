/**
 * The built-in `dashboardAuth` login page (`GET <basePath>/login`). Deliberately a small,
 * dependency-free, hand-authored HTML page — NOT part of the bundled React SPA — so gating the
 * dashboard shell doesn't require rebuilding or extending the Vite bundle with a new route/screen.
 *
 * `returnTo` and any error state are read CLIENT-SIDE from `location.search` (never server-echoed
 * into the HTML), so this function's only per-request-ish input is `basePath` — a developer-
 * controlled config value, not user input — and the page body is otherwise a static template.
 * This sidesteps HTML-escaping entirely: there is no reflected query-param interpolation surface
 * to get wrong.
 */
export function renderLoginPage(basePath: string): string {
  const loginAction = `${basePath}/login`;
  const defaultReturnTo = basePath;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Sign in — Durable</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0b0f14;
    color: #e5e7eb;
  }
  main {
    width: 100%;
    max-width: 360px;
    padding: 32px;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 4px;
  }
  p.subtitle {
    margin: 0 0 24px;
    color: #9ca3af;
    font-size: 13px;
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    margin-bottom: 6px;
    color: #cbd5e1;
  }
  input {
    width: 100%;
    padding: 8px 10px;
    margin-bottom: 16px;
    border-radius: 6px;
    border: 1px solid #374151;
    background: #111827;
    color: #e5e7eb;
    font-size: 14px;
  }
  input:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }
  button {
    width: 100%;
    padding: 9px 10px;
    border-radius: 6px;
    border: none;
    background: #3b82f6;
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  button:hover:not(:disabled) { background: #2563eb; }
  #error {
    display: none;
    margin-bottom: 16px;
    padding: 8px 10px;
    border-radius: 6px;
    background: #7f1d1d;
    color: #fecaca;
    font-size: 13px;
  }
</style>
</head>
<body>
<main>
  <h1>Durable control plane</h1>
  <p class="subtitle">Sign in to continue.</p>
  <div id="error" role="alert">Invalid username or password.</div>
  <form id="login-form" autocomplete="on">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" autocomplete="username" required autofocus />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button id="submit" type="submit">Sign in</button>
  </form>
</main>
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
</script>
</body>
</html>`;
}
