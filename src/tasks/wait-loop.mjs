// One bounded wait loop for task and research status calls. Callers supply
// what "settled" means and how to sleep; the loop owns the deadline, the
// remaining-time arithmetic, and the shape both waits return.
/**
 * @param options.timeoutSeconds - caller-visible timeout
 * @param options.isSettled - async () => boolean; must refresh before deciding
 * @param options.waitForChange - async remainingMs => void
 * @param options.now - injectable clock, for tests
 * @returns {Promise<{timedOut: boolean, timeoutSeconds: number, waitedMs: number}>}
 */
export async function pollUntilSettled({
  timeoutSeconds,
  isSettled,
  waitForChange,
  now = Date.now,
}) {
  const startedAt = now();
  const timeoutMs = timeoutSeconds * 1000;
  for (;;) {
    if (await isSettled()) {
      return {timedOut: false, timeoutSeconds, waitedMs: now() - startedAt};
    }
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) {
      return {timedOut: true, timeoutSeconds, waitedMs: now() - startedAt};
    }
    await waitForChange(remaining);
  }
}
