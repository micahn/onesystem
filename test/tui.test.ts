/**
 * The footer status line.
 *
 * The line is the whole feature, so it is a pure function of the health report and tested
 * as one. Formatting is what rots: a new backend state gets added, nobody remembers there
 * is a switch in `tui.ts`, and the TUI quietly starts saying "cold" for a backend that is
 * mid-load.
 */

import { describe, expect, test } from "bun:test"
import { formatUsage, statusLine, statusReport } from "../src/plugin/tui.ts"
import { healthReport } from "../src/health.ts"
import type { BackendStatus } from "../src/backend/types.ts"

function backend(over: Partial<BackendStatus> = {}): BackendStatus {
  return {
    name: "laya",
    transport: "stdio-mcp",
    state: "cold",
    inflight: 0,
    idleMs: 0,
    local: true,
    calls: 0,
    errors: 0,
    lastMs: null,
    meanMs: null,
    inBytes: 0,
    outBytes: 0,
    answered: 0,
    byType: {},
    ...over,
  }
}

const report = (...backends: BackendStatus[]) => healthReport({ idleShutdownSecs: 600, backends })

describe("status line", () => {
  test("a daemon that was never up is an error", () => {
    expect(statusLine(null)).toEqual({ text: "onesystem: not running", tone: "error" })
  })

  test("a daemon that wound down on its idle window is not an error", () => {
    // The bug this fixes: both of these rendered as "down" in the error colour, because
    // nothing distinguished them. A daemon that stopped after its quiet window has done
    // exactly what it was configured to do -- it released the GPU and went away, which is
    // the entire point of the idle window. Showing that as breakage is a false alarm, and
    // a card that cries wolf is a card nobody reads.
    expect(statusLine(null, true)).toEqual({ text: "onesystem: idle (GPU released)", tone: "info" })
  })

  test("and the distinction is only made once a healthy daemon has actually been seen", () => {
    // A TUI that has just started cannot know, so it says "not running" -- which is the
    // truth from where it is standing.
    expect(statusLine(null, false).tone).toBe("error")
  })

  test("a warm backend is the good state and is called out", () => {
    expect(statusLine(report(backend({ state: "warm" })))).toEqual({
      text: "onesystem: laya warm",
      tone: "success",
    })
  })

  test("a cold backend is not coloured like a problem", () => {
    // Cold is the cheap, correct default for most of a session's life. If it looked like
    // an error, every idle session would read as broken.
    expect(statusLine(report(backend()))).toEqual({ text: "onesystem: laya cold", tone: "info" })
  })

  test("a failed backend is an error, even alongside a warm one", () => {
    const line = statusLine(report(backend({ name: "ok", state: "warm" }), backend({ name: "bad", state: "failed" })))
    expect(line.tone).toBe("error")
    expect(line.text).toContain("bad failed")
  })

  test("a remote-only daemon does not claim a local model", () => {
    // A `systemone-http` backend is somebody else's server. Reporting it as a resident
    // model would be a lie about what is holding the GPU, which is the whole point of
    // the line.
    const line = statusLine(report(backend({ name: "rev", transport: "systemone-http", local: false, state: "warm" })))
    expect(line).toEqual({ text: "onesystem: up, no local model", tone: "info" })
  })

  test("several local backends are summarised rather than listed forever", () => {
    const line = statusLine(
      report(
        backend({ name: "a", state: "warm" }),
        backend({ name: "b" }),
        backend({ name: "c" }),
        backend({ name: "d" }),
      ),
    )
    expect(line.text).toBe("onesystem: a warm, b cold +2")
  })

  test("a daemon with no backends at all is distinguished from a cold one", () => {
    expect(statusLine(report())).toEqual({ text: "onesystem: up, no backends", tone: "warning" })
  })
})


describe("the detail view", () => {
  const withCalls = report(
    backend({ name: "laya", state: "warm", calls: 42, errors: 2, lastMs: 29, meanMs: 310, inflight: 1 }),
    backend({ name: "julia", state: "cold" }),
  )

  test("shows calls, failures and latency per model", () => {
    const out = statusReport(withCalls, "http://127.0.0.1:7331")
    expect(out).toContain("42 calls, 2 failed")
    expect(out).toContain("last 29ms  mean 310ms")
    expect(out).toContain("1 in flight")
    expect(out).toContain("idle window 600s")
  })

  test("a model that has never been called says so rather than showing 0ms", () => {
    // Zero would read as "instant", which is a claim. "no calls yet" is the truth and is
    // the more useful thing to see about a cold model.
    expect(statusReport(withCalls, null)).toContain("no calls yet")
  })

  test("a model with no failures does not mention failures", () => {
    const out = statusReport(report(backend({ calls: 1, errors: 0 })), null)
    expect(out).not.toContain("failed")
  })

  test("volume is shown in bytes and answered questions, not tokens", () => {
    const out = statusReport(
      report(
        backend({
          calls: 3,
          answered: 5,
          byType: { choice: 4, noul: 1 },
          inBytes: 2048,
          outBytes: 1_500_000,
          lastMs: 12,
          meanMs: 30,
        }),
      ),
      null,
    )
    expect(out).toContain("5 answered (4 choice, 1 noul)")
    expect(out).toContain("2.0KB in / 1.4MB out")
    expect(out).not.toMatch(/token/i)
  })

  test("a model with nothing answered shows a zero rather than a blank", () => {
    expect(statusReport(report(backend({ calls: 2, answered: 0, byType: {} })), null)).toContain("0 answered")
  })

  test("a daemon that is not running says so plainly", () => {
    expect(statusReport(null, "http://127.0.0.1:7331")).toContain("no daemon is answering")
  })

  test("a daemon that wound down is explained, not reported as a failure", () => {
    const out = statusReport(null, "http://127.0.0.1:7331", true)
    expect(out).toContain("wound itself down on the idle window")
    expect(out).toContain("not a failure")
    // And the thing that is actually actionable.
    expect(out).toContain("next tool call restarts it")
  })

  test("no duration is invented, because the plugin only learns of it on the next poll", () => {
    const out = statusReport(null, "http://127.0.0.1:7331", true)
    expect(out).not.toMatch(/\d+s ago|for \d+s/)
  })
})


describe("the usage line", () => {
  test("shows calls, answered and volume on one line", () => {
    // This is what the card renders, so it is the one that has to be short enough to fit a
    // sidebar and still carry the three numbers.
    expect(
      formatUsage(backend({ calls: 3, answered: 5, inBytes: 2048, outBytes: 1024 })),
    ).toBe("3 calls · 5 answered · 3.0KB moved")
  })

  test("a model that has never been called reads as zero, not as missing", () => {
    expect(formatUsage(backend())).toBe("0 calls · 0 answered · 0B")
  })

  test("volume is in and out together, because the split is detail", () => {
    // The dialog shows the split; the card does not have the width for it, and "moved" is
    // the question the card is answering.
    // 100_000 bytes is 97.7 KiB, not 100 KB -- the formatter divides by 1024 like the rest
    // of the tool does, and the test should say so rather than round in its favour.
    const out = formatUsage(backend({ inBytes: 10_000, outBytes: 90_000 }))
    expect(out).toContain("97.7KB moved")
  })
})
