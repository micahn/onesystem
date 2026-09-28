/**
 * Call accounting: how often, how long, how many failures.
 *
 * The adapters already increment `inflight` on every call, so this is the same bookkeeping
 * finished rather than a new thing. It lives in its own module because both adapters need
 * it and neither should own it — the counters describe a *call*, not a transport.
 *
 * Deliberately not token counts. Neither model reports them, and a local model bills
 * nothing, so a token number would be an estimate presented as a measurement. `calls`,
 * `errors` and the latencies are all things the daemon actually witnessed.
 */

export interface Usage {
  calls: number
  errors: number
  lastMs: number | null
  /** Running mean over completed calls. Kept as a total so there is no array to grow. */
  meanMs: number | null
}

export const emptyUsage = (): Usage => ({ calls: 0, errors: 0, lastMs: null, meanMs: null })

/**
 * Time a call and fold it into the totals.
 *
 * `run` and `now` are both passed in rather than read from `this`, so a test can assert on
 * the arithmetic without sleeping. Pass `() => backend.now()` and not `backend.now`: a
 * bare method reference loses its receiver, and the failure is a `this is undefined` thrown
 * from inside the clock rather than anything to do with timing.
 */
export async function record<T>(
  usage: Usage,
  run: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const started = now()
  try {
    const result = await run()
    finish(usage, now() - started, false)
    return result
  } catch (err) {
    finish(usage, now() - started, true)
    throw err
  }
}

/**
 * Fold one finished call into the totals.
 *
 * A failed call still counts as a call and still has a duration — a call that failed after
 * 30 seconds of a cold load is the slowest thing that happened, and dropping failures from
 * the timing would make a broken backend look fast.
 */
export function finish(usage: Usage, ms: number, failed: boolean): void {
  usage.calls++
  if (failed) usage.errors++
  usage.lastMs = Math.round(ms)
  const prior = usage.meanMs === null ? 0 : usage.meanMs * (usage.calls - 1)
  usage.meanMs = Math.round((prior + ms) / usage.calls)
}
