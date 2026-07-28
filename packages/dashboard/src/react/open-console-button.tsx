import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { OpenConsoleOptions } from '../client/console-session.js';
import { useOpenDurableConsole } from './use-open-console.js';

export interface OpenDurableConsoleButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'>,
    OpenConsoleOptions {
  /** Button label. Defaults to "Open Durable". */
  children?: ReactNode;
  /** Shown while the session is being minted. Defaults to "Opening…". */
  pendingLabel?: ReactNode;
  /**
   * Render the refusal yourself. Omit and the button renders a plain `<p role="alert">` under
   * itself; pass `null` to render nothing and read the error from {@link useOpenDurableConsole}.
   */
  renderError?: ((error: Error) => ReactNode) | null;
}

/**
 * Drop-in launcher: the top tier, for a host that just wants a working button.
 *
 * Deliberately unstyled — it emits a bare `<button>` and forwards `className`/`style`/every other
 * button prop, so it inherits whatever design system the host already has instead of importing CSS
 * that would fight it. When it doesn't fit, drop to {@link useOpenDurableConsole} (same behaviour,
 * your markup) or to `openDurableConsole` (no React at all).
 *
 * The error is rendered by default rather than swallowed: a refused mint is the case a launcher most
 * needs to surface, and a button that silently does nothing reads as broken rather than forbidden.
 */
export function OpenDurableConsoleButton({
  children,
  pendingLabel,
  renderError,
  basePath,
  headers,
  fetch: fetchImpl,
  signal,
  navigate,
  disabled,
  ...buttonProps
}: OpenDurableConsoleButtonProps) {
  const { open, isPending, error } = useOpenDurableConsole({
    ...(basePath !== undefined ? { basePath } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(navigate !== undefined ? { navigate } : {}),
  });

  return (
    <>
      <button
        type="button"
        {...buttonProps}
        onClick={open}
        disabled={disabled || isPending}
        aria-busy={isPending || undefined}
      >
        {isPending ? (pendingLabel ?? 'Opening…') : (children ?? 'Open Durable')}
      </button>
      {error &&
        renderError !== null &&
        (renderError?.(error) ?? <p role="alert">{error.message}</p>)}
    </>
  );
}
