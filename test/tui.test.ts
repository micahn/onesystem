/**
 * Verify status text, counts, and tones from health reports without a terminal.
 */

import { describe, expect, test } from "bun:test"
import { cardRows, daemonView, formatUsage, statusLine, statusReport } from "../src/plugin/tui.ts"
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
    expect(out).toContain("2.0K in / 1.4M out")
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
  test("shows calls, answered and volume, short enough for a sidebar", () => {
    // Measured in columns. This string renders on its own line inside the sidebar, so
    // every character it spends is one the model name does not get.
    expect(
      formatUsage(backend({ calls: 3, answered: 5, inBytes: 2048, outBytes: 1024 })),
    ).toBe("3 calls · 5 answered · 3.0K")
  })

  test("a model that has never been called reads as zero, not as missing", () => {
    expect(formatUsage(backend())).toBe("0 calls · 0 answered · 0B")
  })

  test("volume is in and out together, because the split is detail", () => {
    // In and out are summed: the card has the width for one number and the dialog already
    // shows the split. 100_000 bytes is 97.7 KiB, not 100 KB -- the formatter divides by
    // 1024, and the test should say so rather than round in its favour.
    const out = formatUsage(backend({ inBytes: 10_000, outBytes: 90_000 }))
    expect(out).toContain("97.7K")
  })
})

/**
 * The card, and whether it agrees with the other two renderers.
 *
 * The sidebar had no test at all: `setup` was never invoked by any test, so roughly 230 of
 * this file's 405 lines had no seam, and the three exports that existed were exported *so
 * a test could call them* — the module's testable interface and its risky interface were
 * disjoint. `cardRows` is that seam. It is a pure function of the same `DaemonView` the
 * footer and the dialog read, which is what makes "do they agree" a question with an
 * answer rather than a coincidence.
 */
describe("the sidebar card", () => {
  const text = (h: ReturnType<typeof report> | null, woundDown = false) =>
    cardRows(daemonView(h, woundDown)).map((r) => r.text)
  const flat = (h: ReturnType<typeof report> | null, woundDown = false) => text(h, woundDown).join("\n")

  test("a remote backend is not counted as a model by any of the three renderers", () => {
    // The disagreement the issue was written about, concretely. One local warm beside one
    // remote cold: the footer filters on `local` and had a test calling the alternative "a
    // lie", the card counted every backend, and the dialog filtered nothing. One report,
    // three answers.
    const h = report(
      backend({ name: "laya", state: "warm" }),
      backend({ name: "rev", transport: "systemone-http", local: false, state: "cold" }),
    )

    // Footer: names the one model.
    expect(statusLine(h)).toEqual({ text: "onesystem: laya warm", tone: "success" })

    // Card: the headline counted every backend, so this read `1/2 warm` — claiming half
    // the GPU is held by a model, when one of the two is somebody else's server.
    expect(flat(h)).toContain("onesystem  1/1 warm")
    expect(flat(h)).not.toContain("1/2 warm")

    // And the remote is still shown, just not as a model.
    expect(flat(h)).toContain("rev cold (remote)")

    // Dialog: listed, labelled, and the idle window says it does not apply to it.
    const dialog = statusReport(h, "http://127.0.0.1:7331")
    expect(dialog).toContain("rev  (remote)  cold")
    expect(dialog).toContain("applies to local models only")
  })

  test("warm/n counts models in the card and matches what the footer says", () => {
    const h = report(
      backend({ name: "a", state: "warm" }),
      backend({ name: "b", state: "cold" }),
      backend({ name: "c", state: "warm" }),
    )
    // The footer summarises two and counts the rest; the card totals all three. The
    // numbers have to be describing the same set of things.
    expect(statusLine(h).text).toBe("onesystem: a warm, b cold +1")
    expect(flat(h)).toContain("onesystem  2/3 warm")
  })

  test("a remote-only daemon says so in all three places rather than claiming a model", () => {
    const h = report(backend({ name: "rev", transport: "systemone-http", local: false, state: "warm" }))
    expect(statusLine(h)).toEqual({ text: "onesystem: up, no local model", tone: "info" })
    // `1/1 warm` here would be the same lie, in the same words, in the other renderer.
    expect(flat(h)).toContain("onesystem  0/0 warm")
    expect(flat(h)).toContain("no local model — the GPU is free")
    expect(statusReport(h, "http://127.0.0.1:7331")).toContain("no local model — nothing here holds the GPU")
  })

  test("absent and wound-down are distinguished by the card the way the footer does it", () => {
    // The distinction is the whole reason `sawHealthy` exists, and it was written out
    // three times. The card and the footer had the same two branches; only one of the
    // three renderers was tested for it.
    expect(text(null, false)).toEqual(["onesystem  not running"])
    expect(cardRows(daemonView(null, false))[0]!.tone).toBe("error")
    expect(statusLine(null, false).tone).toBe("error")

    expect(flat(null, true)).toContain("idle, GPU released")
    expect(flat(null, true)).toContain("next tool call restarts it")
    expect(cardRows(daemonView(null, true))[0]!.tone).toBe("muted")
    expect(statusLine(null, true).tone).toBe("info")
    expect(statusReport(null, null, true)).toContain("wound itself down on the idle window")
  })

  test("a cold model's idle number never answers for a warm one", () => {
    // The concrete bug in the card's idle arithmetic. It took the quietest *local*
    // backend whatever state it was in, so a cold backend's `idleMs` -- measured from when
    // it was registered, since it has never been called -- could be the minimum and would
    // then answer for the warm model next to it. Here the warm model was last touched
    // 590s into a 600s window, so it has 10s left; the cold one was registered 0.5s ago.
    // The old card took the cold one's number and said 600s, understating by 590s the
    // urgency of the one thing it exists to report.
    const h = report(
      backend({ name: "warm-one", state: "warm", idleMs: 590_000 }),
      backend({ name: "cold-one", state: "cold", idleMs: 500 }),
    )
    expect(flat(h)).toContain("idle in 10s")
    expect(flat(h)).not.toContain("winding down")
  })

  test("a model being called right now is not about to be released", () => {
    // `inflight` is the sweep's fourth condition and the card ignored it. A backend in
    // flight is the least likely thing in the system to be released in the next second.
    const h = report(backend({ name: "busy", state: "warm", idleMs: 599_000, inflight: 2 }))
    expect(flat(h)).not.toContain("winding down")
    expect(flat(h)).not.toContain("idle in")
  })

  test("with nothing warm there is no countdown, because there is nothing to wind down", () => {
    // `anyLocalWarm` already ships on the report for exactly this and the TUI never read
    // it. A cold daemon was showing "winding down" for a backend that had never started.
    const h = report(backend({ state: "cold", idleMs: 900_000 }))
    expect(flat(h)).not.toContain("winding down")
    expect(flat(h)).not.toContain("idle in")
  })

  test("the card's usage line is the same one the dialog's numbers come from", () => {
    // `formatUsage` claimed to be shared by both and was not: the dialog laid out its own.
    // They cannot be one function -- the dialog has the width for the in/out split and the
    // question types -- so what is pinned here is that they read the same fields and sum
    // to the same total, which is the part that can silently drift.
    const b = backend({ calls: 7, answered: 7, inBytes: 2_048, outBytes: 1_024 })
    const h = report(b)
    expect(flat(h)).toContain("7 calls · 7 answered · 3.0K")
    const dialog = statusReport(h, null)
    expect(dialog).toContain("7 calls")
    expect(dialog).toContain("7 answered")
    expect(dialog).toContain("2.0K in / 1.0K out")
  })
})
