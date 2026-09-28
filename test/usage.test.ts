/**
 * Call accounting.
 *
 * The arithmetic is small, but it is the kind of small that is wrong in a way nobody
 * notices: a running mean that drops a failure looks like a speedup, and a counter that
 * resets on error makes a broken backend look unused.
 */

import { describe, expect, test } from "bun:test"
import { emptyUsage, finish, record } from "../src/backend/usage.ts"
import { FakeBackend } from "./fixtures/fake-backend.ts"
import { healthReport } from "../src/health.ts"

describe("usage", () => {
  test("starts empty, with no latency to report rather than a zero one", () => {
    const u = emptyUsage()
    expect(u).toEqual({ calls: 0, errors: 0, lastMs: null, meanMs: null })
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
