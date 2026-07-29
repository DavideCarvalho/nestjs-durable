import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConsoleSessionError,
  type OpenConsoleOptions,
  openDurableConsole,
} from '../client/console-session.js';

/**
 * React layer over `openDurableConsole` — the middle tier between the bare function
 * (`../client/console-session.ts`) and the drop-in `<OpenDurableConsoleButton>`.
 *
 * You get the state a launcher UI actually needs (in-flight, error) and keep full control of the
 * markup. Nothing here is Durable-specific beyond the endpoint: it is a mint-then-navigate call with
 * the two states that call can be in.
 */
export interface UseOpenConsoleResult {
  /** Start the mint-then-navigate. Never rejects — read `error` instead. */
  open: () => void;
  /** True from the click until the navigation starts, or until it fails. */
  isPending: boolean;
  /** The last refusal, or `null`. Cleared when `open()` is called again. */
  error: ConsoleSessionError | null;
  /** Drop a stale error without retrying — e.g. when a dialog closes. */
  reset: () => void;
}

export function useOpenDurableConsole(options: OpenConsoleOptions = {}): UseOpenConsoleResult {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ConsoleSessionError | null>(null);

  // Kept in a ref so a caller passing an inline object literal (the common case) doesn't change the
  // identity of `open` on every render, which would defeat memoizing anything downstream.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const open = useCallback(() => {
    setIsPending(true);
    setError(null);
    void openDurableConsole(optionsRef.current)
      .then(() => {
        // Deliberately NOT clearing `isPending` on success: the navigation is already underway and
        // this component is about to be torn down. Flipping the button back to idle first produces
        // a visible flicker of "ready to click again" on a page that is leaving.
        //
        // The page leaving is not the same as the page dying — see the `pageshow` effect below,
        // which is what un-sticks this flag when the user comes back.
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ConsoleSessionError
            ? cause
            : new ConsoleSessionError(String(cause), 'unknown'),
        );
        setIsPending(false);
      });
  }, []);

  // The counterpart to leaving `isPending` set on success. That choice assumes the launcher page is
  // discarded once the navigation completes — but with the browser's back/forward cache it is not:
  // pressing Back restores this page from memory with React state intact, so the user lands back on
  // a spinner that never stops, on a button `disabled` by that very flag. This is the one signal
  // that says "you are looking at a restored page": browsers fire `pageshow` with
  // `persisted === true` only on a bfcache restore.
  //
  // Guard on `persisted` rather than on `pageshow` alone. A plain `pageshow` also fires on every
  // ordinary load, and clearing the flag there would resurrect the flicker this hook exists to
  // avoid — a mint that is genuinely still in flight (the user never left) must keep its spinner.
  useEffect(() => {
    // No `window` under SSR — and nothing to restore there either.
    if (typeof window === 'undefined') return;
    const onPageShow = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) setIsPending(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { open, isPending, error, reset };
}

/**
 * TanStack Query integration WITHOUT a TanStack dependency: the returned object is the shape
 * `useMutation` takes, so a host that already uses Query wires the launcher into its own cache,
 * devtools and error handling with no extra adapter — and a host that doesn't never pays for it.
 *
 * ```ts
 * const { mutate, isPending } = useMutation(openDurableConsoleMutationOptions({ headers }));
 * ```
 */
export function openDurableConsoleMutationOptions(options: OpenConsoleOptions = {}): {
  mutationKey: readonly unknown[];
  mutationFn: () => Promise<void>;
} {
  return {
    mutationKey: ['durable', 'console', 'open', options.basePath ?? null] as const,
    mutationFn: () => openDurableConsole(options),
  };
}
