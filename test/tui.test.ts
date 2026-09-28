/**
 * The footer status line.
 *
 * The line is the whole feature, so it is a pure function of the health report and tested
 * as one. Formatting is what rots: a new backend state gets added, nobody remembers there
 * is a switch in `tui.ts`, and the TUI quietly starts saying "cold" for a backend that is
 * mid-load.
 */

import { describe, expect, test } from "bun:test"
import { statusLine, statusReport } from "../src/plugin/tui.ts"
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
    ...over,
  }
}

const report = (...backends: BackendStatus[]) => healthReport({ idleShutdownSecs: 600, backends })

describe("status line", () => {
  test("a daemon that is not answering says so", () => {
    // The distinction the user needs: "the daemon is gone" is not the same as "the daemon
    // is up and idle", and opencode's own MCP indicator cannot tell them apart.
    expect(statusLine(null)).toEqual({ text: "onesystem: down", tone: "error" })
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

  test("a daemon that is not running says so plainly", () => {
    expect(statusReport(null, "http://127.0.0.1:7331")).toContain("no daemon is answering")
  })
})
