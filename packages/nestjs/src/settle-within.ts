/** Resolve when `p` settles or after `timeoutMs`, whichever comes first; never rejects. */
export async function settleWithin(p: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([p.then(undefined, () => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
