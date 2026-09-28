/**
 * Usage totals and timing must include failures instead of making them look like speedups.
 */

import { describe, expect, test } from "bun:test"
import { byteSize, countAnswers, emptyUsage, finish, record } from "../src/backend/usage.ts"
import { FakeBackend } from "./fixtures/fake-backend.ts"
import { healthReport } from "../src/health.ts"

describe("usage", () => {
  test("starts empty, with no latency to report rather than a zero one", () => {
    const u = emptyUsage()
    expect(u).toEqual({ calls: 0, errors: 0, lastMs: null, meanMs: null, inBytes: 0, outBytes: 0, answered: 0, byType: {} })
    // Zero would be a claim that a call took no time. Null is "we do not know yet", which
    // is the truth before the first call.
  })

  test("a call is counted and timed", () => {
    const u = emptyUsage()
    finish(u, 120, false)
    expect(u.calls).toBe(1)
    expect(u.errors).toBe(0)
    expect(u.lastMs).toBe(120)
    expect(u.meanMs).toBe(120)
  })

  test("the mean is a running mean, not a sum divided by the latest count", () => {
    const u = emptyUsage()
    finish(u, 100, false)
    finish(u, 200, false)
    finish(u, 300, false)
    expect(u.lastMs).toBe(300)
    expect(u.meanMs).toBe(200)
  })

  test("a failed call still counts and still has a duration", () => {
    // Dropping failures from the timing would make a backend that is failing after 30s
    // of cold load look like the fastest thing in the system.
    const u = emptyUsage()
    finish(u, 100, false)
    finish(u, 5000, true)
    expect(u.calls).toBe(2)
    expect(u.errors).toBe(1)
    expect(u.lastMs).toBe(5000)
    expect(u.meanMs).toBe(2550)
  })

  test("record wraps a call and folds in the result", async () => {
    const u = emptyUsage()
    let t = 0
    const clock = () => (t += 50)
    const value = await record(u, async () => "ok", clock)
    expect(value).toBe("ok")
    expect(u.calls).toBe(1)
    expect(u.lastMs).toBe(50)
  })

  test("record rethrows but still counts the failure", async () => {
    const u = emptyUsage()
    let t = 0
    await expect(
      record(u, async () => {
        throw new Error("boom")
      }, () => (t += 30)),
    ).rejects.toThrow("boom")
    expect(u.calls).toBe(1)
    expect(u.errors).toBe(1)
  })
  test("the clock is called as a function, not dereferenced", async () => {
    // A bare method reference loses its receiver, and the symptom is a `this is undefined`
    // thrown from inside the clock -- which looks like a timing bug and is not one. The
    // clock is deliberately method-shaped, and the call is a closure over it.
    const u = emptyUsage()
    const clock = { at: 0, now(): number { return (this.at += 20) } }
    await record(u, async () => "ok", () => clock.now())
    expect(u.lastMs).toBe(20)
  })
})

describe("usage reaches the health report", () => {
  test("the counters ride out on the existing report, with no new endpoint", async () => {
    const fake = new FakeBackend({ name: "m" })
    await fake.call({ method: "tools/call", params: {} })
    await fake.call({ method: "tools/call", params: {} })

    const status = fake.describe()
    expect(status.calls).toBeGreaterThanOrEqual(1)
    const report = healthReport({ idleShutdownSecs: 600, backends: [status] })
    // A consumer reading /health gets the usage with no extra request, because the backends
    // were already in the payload.
    expect(report.backends[0]!.calls).toBe(status.calls)
    expect(report.backends[0]!.lastMs).toBe(status.lastMs)
  })

  test("a backend that has never been called reports null latency, not zero", () => {
    const fake = new FakeBackend({ name: "cold" })
    const s = fake.describe()
    expect(s.calls).toBe(0)
    expect(s.lastMs).toBeNull()
    expect(s.meanMs).toBeNull()
  })
})


describe("volume", () => {
  test("bytes are counted in both directions", async () => {
    const u = emptyUsage()
    const payload = { state: "a".repeat(100), questions: { q: 1 } }
    await record(u, async () => ({ answers: {} }), Date.now, payload)
    expect(u.inBytes).toBe(Buffer.byteLength(JSON.stringify(payload)))
    expect(u.outBytes).toBeGreaterThan(0)
  })

  test("questions are counted and broken down by type", () => {
    const u = emptyUsage()
    finish(u, 1, false, {
      answers: {
        a: { type: "choice", choice: "x" },
        b: { type: "noul" },
        c: { type: "choice", choice: "y" },
      },
    })
    expect(u.answered).toBe(3)
    expect(u.byType).toEqual({ choice: 2, noul: 1 })
  })

  test("counts accumulate across calls", () => {
    const u = emptyUsage()
    finish(u, 1, false, { answers: { a: { type: "choice" } } })
    finish(u, 1, false, { answers: { b: { type: "score" }, c: { type: "score" } } })
    expect(u.answered).toBe(3)
    expect(u.byType).toEqual({ choice: 1, score: 2 })
  })

  test("an answer with no type is counted as unknown, not dropped", () => {
    // Dropping it would make the total disagree with the number of questions asked, which
    // is the one thing this number has to be right about.
    const u = emptyUsage()
    finish(u, 1, false, { answers: { a: {}, b: { type: "choice" } } })
    expect(u.answered).toBe(2)
    expect(u.byType).toEqual({ unknown: 1, choice: 1 })
  })

  test("answers are found inside an MCP content block, where they actually arrive", () => {
    // The bug this catches: a model answering in JSON puts that JSON in a *string* inside
    // the first text content block, so the object the adapter holds is the protocol's
    // rather than the model's. Looking for `answers` on it directly finds nothing, and the
    // counter reads a permanent zero while the byte count beside it looks perfectly fine.
    const u = emptyUsage()
    finish(u, 1, false, {
      content: [
        {
          type: "text",
          text: JSON.stringify({ answers: { q: { type: "choice" }, r: { type: "noul" } } }),
        },
      ],
    })
    expect(u.answered).toBe(2)
    expect(u.byType).toEqual({ choice: 1, noul: 1 })
  })

  test("a text block that is not JSON is not counted and does not throw", () => {
    const u = emptyUsage()
    expect(() => finish(u, 1, false, { content: [{ type: "text", text: "the answer is 42" }] })).not.toThrow()
    expect(u.answered).toBe(0)
  })

  test("an object with answers already unwrapped still counts", () => {
    const u = emptyUsage()
    finish(u, 1, false, { answers: { q: { type: "score" } } })
    expect(u.answered).toBe(1)
  })

  test("a result that is not a decision is counted as zero, not guessed at", () => {
    // `tools/list` and the systemone pass-through both return something else entirely.
    const u = emptyUsage()
    finish(u, 1, false, { tools: [{ name: "predict" }] })
    expect(u.answered).toBe(0)
    expect(u.byType).toEqual({})
    expect(countAnswers({ tools: [] })).toBeNull()
    expect(countAnswers(null)).toBeNull()
    expect(countAnswers("nope")).toBeNull()
  })

  test("an unserialisable payload does not throw after a call that worked", () => {
    const u = emptyUsage()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(byteSize(circular)).toBe(0)
    expect(() => finish(u, 1, false, circular)).not.toThrow()
  })
})
