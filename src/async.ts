/**
 * Deadline and error-description helpers, shared by everything that has to wait for
 * something that might not come back.
 *
 * These existed as two private copies each — `describe` in the stdio adapter and
 * `describeUnknown` in the supervisor, with different output formats for the same error,
 * and `withTimeout` in both places, byte-identical. Two copies of a timeout means a fix
 * to one of them (clearing the timer on a path that settles then aborts, say) lands in
 * one, and the other keeps the bug. One copy, one format.
 */

/**
 * Describe an error for a log line or a tool result.
 *
 * `Error` is dropped from the prefix because every ordinary failure would otherwise read
 * `Error: connect ECONNREFUSED`, which says nothing. A named subclass keeps its name,
 * because that is the part that identifies it: `BackendError`, `McpError`, `TypeError`.
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
 * A cancellation that fires on a timer.
 *
 * This is the difference between a timeout that bounds the caller and one that bounds the
 * work. Rejecting after `ms` while the work keeps running is not a timeout, it is a
 * guess: the request is abandoned but the model call is still holding a connection, and
 * any accounting built on "a call is in flight" stays stuck.
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
 * Reject if `promise` has not settled within `ms`, without otherwise touching it.
 *
 * Paired with a `Deadline` when the work can be cancelled: abort first so the work
 * actually stops, then race so a caller is never left hanging on an adapter that ignored
 * the signal.
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
