/**
 * Slow-step lines for service.log.
 *
 * A fresh proxy holds readiness until client startup reconciliation settles. When that takes
 * minutes, service.log shows only a gap between the Codex sync lines and "Client startup work
 * complete", and nothing says which step waited. A step that crosses the threshold logs one line
 * with its label and elapsed time. Labels are fixed strings or provider names: never credentials,
 * account ids, or request content.
 */
export const SLOW_STEP_LOG_MS = 1_000;

export async function logIfSlow<T>(
  label: string,
  run: () => Promise<T>,
  log: (message: string) => void = message => console.log(message),
  now: () => number = Date.now,
): Promise<T> {
  const started = now();
  try {
    return await run();
  } finally {
    const elapsed = now() - started;
    if (elapsed >= SLOW_STEP_LOG_MS) log(`[slow-step] ${label} took ${elapsed}ms`);
  }
}
