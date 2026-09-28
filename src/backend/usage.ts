/**
 * Shared call counts, timing, bytes, answers, and activity tracking.
 * Models do not report tokens. Count answers only when a result has an answers map;
 * other result shapes contribute zero answers.
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
 * Read model JSON from MCP text content, or keep an already-unwrapped answers object.
 * Callers must still validate the result's shape.
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
 * Count an answers map. Null means unmeasurable; zero means no answers.
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
 * Time a call and update totals. Use a bound clock callback, such as
 * () => backend.now(), so methods retain their receiver.
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
 * Include failures in call and timing totals so a broken backend cannot appear fast.
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

/**
 * Track a full call, including cold startup, with consistent timing across adapters.
 * Always release inflight in finally, including after cancellation or failure;
 * a leaked count prevents idle shutdown. Supply a bound clock callback.
 */
export class CallLedger {
  #inflight = 0
  #lastActivityAt: number
  readonly usage: Usage = emptyUsage()

  constructor(private readonly now: () => number = Date.now) {
    this.#lastActivityAt = now()
  }

  /** Calls currently running. The sweep reads this, and it must return to zero. */
  get inflight(): number {
    return this.#inflight
  }

  /** When the last call started or finished. `idleMs` is measured from here. */
  get lastActivityAt(): number {
    return this.#lastActivityAt
  }

  /**
   * Reset idle time after lifecycle activity without counting a call.
   */
  touch(): void {
    this.#lastActivityAt = this.now()
  }

  /**
   * Track all backend work, including startup. Validate unsupported methods before
   * entering this function so rejected requests do not count as model calls.
   */
  async track<T>(run: () => Promise<T>, sent?: unknown): Promise<T> {
    this.#inflight++
    this.#lastActivityAt = this.now()
    try {
      return await record(this.usage, run, this.now, sent)
    } finally {
      // Release on success, failure, and cancellation.
      this.#inflight--
      this.#lastActivityAt = this.now()
    }
  }
}
