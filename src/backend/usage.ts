/**
 * Call accounting: how often, how long, how much moved, how many questions were answered.
 *
 * The adapters already increment `inflight` on every call, so this is the same bookkeeping
 * finished rather than a new thing. It lives in its own module because both adapters need
 * it and neither should own it — the counters describe a *call*, not a transport.
 *
 * ## Not tokens
 *
 * Neither model reports tokens — laya answers with `answers`, `routing`, `latency_ms` and
 * `device`, julia with `answers` alone — and a locally-run model bills nothing, so a token
 * number here would be an estimate presented as a measurement. What is reported instead is
 * what the daemon actually witnessed: bytes across the wire, and how many questions came
 * back answered.
 *
 * `answered` is opportunistic. Both models that implement the `predict` contract answer
 * with an `answers` map, so it is counted when it is there and reported as zero when it is
 * not — never guessed from a shape the adapter has not seen.
 */

export interface Usage {
  calls: number
  errors: number
  lastMs: number | null
  /** Running mean over completed calls. Kept as a total so there is no array to grow. */
  meanMs: number | null
  /** Bytes of request payload sent to the model. */
  inBytes: number
  /** Bytes of result payload returned by the model. */
  outBytes: number
  /** Questions answered, summed over every call. */
  answered: number
  /** Answered questions by type: `{ choice: 12, noul: 3 }`. */
  byType: Record<string, number>
}

export const emptyUsage = (): Usage => ({
  calls: 0,
  errors: 0,
  lastMs: null,
  meanMs: null,
  inBytes: 0,
  outBytes: 0,
  answered: 0,
  byType: {},
})

/** Bytes of a JSON payload, or 0 for something that will not serialise. */
export function byteSize(value: unknown): number {
  if (value === undefined) return 0
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
  } catch {
    // A payload that will not serialise is not a reason to fail a call that already
    // worked. Report nothing for it rather than throwing after the fact.
    return 0
  }
}

/**
 * Unwrap a tool result to the value the model actually produced.
 *
 * Over MCP a `tools/call` result is a list of content blocks, and a model that answers in
 * JSON puts that JSON in a *string* inside the first text block. So the object the adapter
 * receives is the protocol's, not the model's, and looking for `answers` on it directly
 * finds nothing — which is how this counter read a permanent zero while the bytes beside
 * it counted perfectly.
 *
 * Unwrapping a content block is a protocol fact, not a model assumption, so it is safe to
 * do unconditionally. The shape after that is still checked before it is believed.
 */
export function unwrapResult(result: unknown): unknown {
  if (result !== null && typeof result === "object" && "answers" in (result as object)) return result
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return result
  for (const block of content) {
    const text = (block as { type?: unknown; text?: unknown } | null)?.text
    if (typeof text !== "string") continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === "object") return parsed
    } catch {
      // Not JSON. The model answered in prose; there is nothing to count and that is fine.
    }
  }
  return result
}

/**
 * Count answered questions in a result, if it has that shape.
 *
 * Returns null for a result that does not, so the caller can tell "answered none" from
 * "this is not a result we can count". That distinction matters: a model answering in a
 * different shape should read as unmeasured, not as silent.
 */
export function countAnswers(raw: unknown): { answered: number; byType: Record<string, number> } | null {
  const answers = (unwrapResult(raw) as { answers?: unknown } | null)?.answers
  if (typeof answers !== "object" || answers === null) return null
  const byType: Record<string, number> = {}
  let answered = 0
  for (const entry of Object.values(answers as Record<string, unknown>)) {
    answered++
    const type = (entry as { type?: unknown } | null)?.type
    const key = typeof type === "string" ? type : "unknown"
    byType[key] = (byType[key] ?? 0) + 1
  }
  return { answered, byType }
}

/**
 * Time a call and fold it into the totals.
 *
 * `run` and `now` are both passed in rather than read from `this`, so a test can assert on
 * the arithmetic without sleeping. Pass `() => backend.now()` and not `backend.now`: a bare
 * method reference loses its receiver, and the failure is a `this is undefined` thrown
 * from inside the clock rather than anything to do with timing.
 */
export async function record<T>(
  usage: Usage,
  run: () => Promise<T>,
  now: () => number = Date.now,
  /** The request payload, for the byte count. */
  sent?: unknown,
): Promise<T> {
  const started = now()
  if (sent !== undefined) usage.inBytes += byteSize(sent)
  try {
    const result = await run()
    finish(usage, now() - started, false, result)
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
export function finish(usage: Usage, ms: number, failed: boolean, result?: unknown): void {
  usage.calls++
  if (failed) usage.errors++
  usage.lastMs = Math.round(ms)
  const prior = usage.meanMs === null ? 0 : usage.meanMs * (usage.calls - 1)
  usage.meanMs = Math.round((prior + ms) / usage.calls)

  if (result !== undefined) {
    usage.outBytes += byteSize(result)
    const answers = countAnswers(result)
    if (answers) {
      usage.answered += answers.answered
      for (const [type, n] of Object.entries(answers.byType)) {
        usage.byType[type] = (usage.byType[type] ?? 0) + n
      }
    }
  }
}
