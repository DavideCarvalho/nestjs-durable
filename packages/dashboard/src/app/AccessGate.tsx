import { type ReactNode, useEffect, useState } from 'react';
import { type ConsoleAccessDenial, onConsoleAccessDenied } from '../client/durable-client';

/**
 * Renders the console until its API refuses the operator (`401`/`403` from `authorize`), then an
 * access-denied state in its place. A `401` carrying a `redirectTo` never gets here: the client
 * navigates to it.
 */
export function AccessGate({ children }: { children: ReactNode }) {
  const [denial, setDenial] = useState<ConsoleAccessDenial | undefined>();
  useEffect(() => onConsoleAccessDenied(setDenial), []);
  if (!denial) return <>{children}</>;
  const signedOut = denial.status === 401;
  return (
    <main role="alert" className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold text-fg">
          {signedOut ? 'Sign in required' : 'Access denied'}
        </h1>
        <p className="mt-2 text-sm text-dim">
          {signedOut
            ? 'Sign in to the application, then reload this page.'
            : 'You do not have access to this console.'}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 rounded border border-line-strong px-3 py-1 text-sm text-fg hover:bg-panel-3"
        >
          Reload
        </button>
      </div>
    </main>
  );
}
