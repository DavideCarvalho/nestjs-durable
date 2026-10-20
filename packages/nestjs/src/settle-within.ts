/** Resolve when `p` settles or after `timeoutMs`, whichever comes first; never rejects. Returns
 *  true when the wait timed out with `p` still pending. */
export async function settleWithin(p: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([p.then(undefined, () => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return timedOut;
}
