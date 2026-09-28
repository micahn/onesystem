/** Shared deadlines and error formatting. */

/**
 * Format an error for logs or tool results. Keep subclass names; omit plain `Error`.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "Error" ? err.message : `${err.name}: ${err.message}`
  }
  return String(err)
}

export interface Deadline {
  /** Pass to whatever does the work. Aborts when the deadline passes. */
  readonly signal: AbortSignal
  /** True if the deadline, rather than the caller, ended it. */
  timedOut(): boolean
  /** Clear the timer. Always call this, or the event loop is held open for `ms`. */
  dispose(): void
}

/**
 * Abort work after `ms`. Pass the signal to the operation so it can release resources.
 */
export function startDeadline(ms: number): Deadline {
  let expired = false
  const controller = new AbortController()
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, ms)
  // Never hold the event loop open on our own account.
  timer.unref?.()
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => clearTimeout(timer),
  }
}

/**
 * Reject after `ms` without cancelling the promise. Pair with a Deadline to abort
 * the work; this timeout also bounds the wait if the operation ignores the signal.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
