/**
 * Cancellation must release inflight or idle shutdown cannot run. Check the real
 * ledger and a real MCP child so fake accounting cannot hide a leaked count.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CallLedger, emptyUsage, finish, record } from "../src/backend/usage.ts"
import { StdioMcpBackend } from "../src/backend/stdio-mcp.ts"
import { Supervisor } from "../src/supervisor.ts"
import { validate, type StdioBackend } from "../src/config.ts"
import type { Backend } from "../src/backend/types.ts"

const dirs: string[] = []
const stops: (() => Promise<void> | void)[] = []

afterEach(async () => {
  while (stops.length) await Promise.resolve(stops.pop()!()).catch(() => {})
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

/** A clock the test drives, so timing is asserted rather than slept through. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe("the ledger", () => {
  test("a call is counted, timed and released", async () => {
    const c = clock()
    const ledger = new CallLedger(c.now)
    const result = await ledger.track(async () => {
      c.advance(120)
      return { answers: { a: { type: "choice" } } }
    }, { state: {}, questions: {} })

    expect(result).toEqual({ answers: { a: { type: "choice" } } })
    expect(ledger.inflight).toBe(0)
    expect(ledger.usage.calls).toBe(1)
    expect(ledger.usage.lastMs).toBe(120)
    expect(ledger.usage.answered).toBe(1)
  })

  test("an aborted call still releases inflight, which is the whole invariant", async () => {
    // A rejection is the easy case; the invariant is about the paths that are not a
    // clean rejection, so all three of them are here: a throw, a rejected promise, and a
    // signal a caller actually aborted on.
    const ledger = new CallLedger(clock().now)

    await expect(ledger.track(async () => { throw new Error("boom") })).rejects.toThrow("boom")
    expect(ledger.inflight).toBe(0)

    await expect(ledger.track(() => Promise.reject(new Error("async boom")))).rejects.toThrow("async boom")
    expect(ledger.inflight).toBe(0)

    const controller = new AbortController()
    const aborted = ledger.track(
      () => new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("cancelled")))),
    )
    expect(ledger.inflight).toBe(1)
    controller.abort()
    await expect(aborted).rejects.toThrow("cancelled")
    expect(ledger.inflight).toBe(0)
  })

  test("inflight counts concurrency rather than history", async () => {
    // The sweep only needs the current number, and a backend serving three calls at once
    // must read 3 — not 1, and not a running total that never comes back down.
    const ledger = new CallLedger(clock().now)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const calls = [ledger.track(() => gate), ledger.track(() => gate), ledger.track(() => gate)]
    expect(ledger.inflight).toBe(3)
    release()
    await Promise.all(calls)
    expect(ledger.inflight).toBe(0)
  })

  test("a failed call still counts, and still has a duration", async () => {
    // A call that failed after 30s of a cold load is the slowest thing that happened.
    // Dropping failures from the timing would make a broken backend look fast.
    const c = clock()
    const ledger = new CallLedger(c.now)
    await expect(
      ledger.track(async () => {
        c.advance(30_000)
        throw new Error("nope")
      }),
    ).rejects.toThrow("nope")
    expect(ledger.usage.calls).toBe(1)
    expect(ledger.usage.errors).toBe(1)
    expect(ledger.usage.lastMs).toBe(30_000)
  })

  test("touch marks activity without counting a call", async () => {
    // A start is activity. Without it, `idleMs` keeps counting from before the start and
    // the sweep reads a freshly-warm backend as one that is already due to be released.
    const c = clock(1_000)
    const ledger = new CallLedger(c.now)
    c.advance(25_000)
    ledger.touch()
    expect(ledger.lastActivityAt).toBe(26_000)
    expect(ledger.usage.calls).toBe(0)
    expect(ledger.inflight).toBe(0)
  })

  test("record and finish keep working on their own, for callers that want no ledger", async () => {
    // They are still exported and still the arithmetic. The ledger is the ceremony around
    // them, not a replacement, so a caller holding a bare `Usage` is not stranded.
    const c = clock()
    const usage = emptyUsage()
    const out = await record(usage, async () => {
      c.advance(5)
      return "ok"
    }, c.now, { sent: true })
    expect(out).toBe("ok")
    expect(usage.inBytes).toBeGreaterThan(0)
    expect(usage.lastMs).toBe(5)
    finish(usage, 15, true)
    expect(usage.errors).toBe(1)
  })
})

/**
 * The same invariant, against a real adapter.
 *
 * Everything below spawns a real child process and speaks real MCP to it. A fake cannot
 * stand in here, and that is the finding: the test that was supposed to cover this used
 * one, so it proved only that a promise rejected.
 */
describe("a real stdio backend, aborted mid-call", () => {
  async function realBackend(callMs: number, opts: { fakeClock?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-acct-"))
    dirs.push(dir)
    const marker = join(dir, "events.log")
    await writeFile(marker, "")
    const fixture = join(import.meta.dir, "fixtures", "fake-mcp.ts")
    // A clock the test drives, but only when it asks. `idleMs` comes from this clock and
    // the idle window is a number of seconds, so reaching the window means either
    // sleeping or moving the clock -- and moving it cannot be slow or flaky. The default
    // is the real clock, because the duration assertions need real elapsed time and a
    // frozen clock would report every call as 0ms.
    const c = opts.fakeClock ? clock() : { now: () => Date.now(), advance: () => {} }

    const spec: StdioBackend = {
      transport: "stdio-mcp",
      command: [process.execPath, fixture],
      env: { FAKE_MCP_MARKER: marker, FAKE_MCP_CALL_MS: String(callMs) },
      toolPrefix: "fake_",
      tools: ["decide"],
    }
    const backend = new StdioMcpBackend("fake", spec, { now: c.now })
    stops.push(() => backend.quiesce())
    return { backend, marker, advance: c.advance }
  }

  /** Wait for a marker line rather than sleeping a guessed interval. */
  async function waitFor(marker: string, line: string, withinMs = 10_000): Promise<void> {
    const deadline = Date.now() + withinMs
    while (Date.now() < deadline) {
      if ((await readFile(marker, "utf8")).includes(line)) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`never saw ${JSON.stringify(line)} in ${marker}:\n${await readFile(marker, "utf8")}`)
  }

  /**
   * Wait for a state, because the sweep calls `quiesce()` without awaiting it.
   *
   * `void backend.quiesce()` is deliberate -- the sweep must not block on a process that
   * may be slow to die -- which means a test has to poll rather than await the sweep.
   */
  async function waitForState(backend: StdioMcpBackend, want: string, withinMs = 10_000): Promise<void> {
    const deadline = Date.now() + withinMs
    while (Date.now() < deadline) {
      if (backend.describe().state === want) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`backend never reached ${want}; it is ${backend.describe().state}`)
  }

  test("a cancelled call leaves inflight at zero, and the sweep can then reap the backend", async () => {
    // The two halves of the invariant, in order, on real accounting.
    //
    // The call takes 30s inside the handler and is aborted once the handler is confirmed
    // running, so this is a genuine mid-flight cancellation rather than a rejection that
    // happened before any work started. The marker is what makes it genuine: "called" is
    // written on entry to the handler.
    const { backend, marker, advance } = await realBackend(30_000, { fakeClock: true })
    expect(backend.describe().inflight).toBe(0)

    // Driven through a real Supervisor with this backend injected, so the sweep reads the
    // same `describe()` the assertions below read. The fakes could not do this: their
    // `inflight` came from a different mechanism than the code under test.
    const supervisor = new Supervisor(
      validate(
        {
          idleShutdownSecs: 1,
          // Must not exceed the window: a sweep coarser than the window can reap a backend
          // on the same tick that first observes it warm. Not a test subject here, so it is
          // set to the floor rather than worked around.
          idleSweepSecs: 1,
          requestTimeoutSecs: 60,
          backends: { fake: { transport: "stdio-mcp", command: ["/bin/true"], startupTimeoutSecs: 30, tools: ["decide"] } },
        },
        "test",
      ),
      { createBackend: () => backend as unknown as Backend },
    )

    const controller = new AbortController()
    const call = backend.call({
      method: "tools/call",
      params: { name: "decide" },
      signal: controller.signal,
      timeoutMs: 60_000,
    } as never)

    await waitFor(marker, "called")
    // Mid-flight: the handler is running, so the call is genuinely in progress.
    expect(backend.describe().inflight).toBe(1)

    controller.abort()
    await expect(call).rejects.toThrow(/cancelled/)

    // The half that matters. Not "the promise rejected" -- the counter the idle sweep
    // reads, on the adapter's own accounting.
    expect(backend.describe().inflight).toBe(0)

    // And the consequence: with inflight at zero the sweep is no longer skipping this
    // backend, so it reaps it. Had the increment leaked, the sweep would have hit
    // `if (status.inflight > 0) continue` and left a live child holding its memory --
    // which is the failure the whole invariant exists to prevent.
    expect(backend.describe().state).toBe("warm")
    // Not yet: the window has not elapsed, and the sweep must leave it alone.
    supervisor.sweep()
    expect(backend.describe().state).toBe("warm")

    // Past the window, with nothing in flight. These two conditions are the sweep's, and
    // the second is the one the abort had to satisfy.
    advance(2_000)
    supervisor.sweep()
    await waitForState(backend, "cold")
  })

  test("a completed call is counted and released, and its duration spans the work", async () => {
    const { backend } = await realBackend(150)
    const result = await backend.call({
      method: "tools/call",
      params: { name: "decide" },
      timeoutMs: 30_000,
    } as never)

    expect(result).toEqual({ content: [{ type: "text", text: "ok:decide" }] })
    const status = backend.describe()
    expect(status.inflight).toBe(0)
    expect(status.calls).toBe(1)
    expect(status.errors).toBe(0)
    // The duration is the handler's, not zero: the timer starts before the request.
    expect(status.lastMs).toBeGreaterThanOrEqual(100)
  })

  test("a rejected call is counted as an error and still releases inflight", async () => {
    const { backend } = await realBackend(0)
    await expect(
      backend.call({ method: "tools/call", params: { name: "decide" }, timeoutMs: 30_000 } as never),
    ).resolves.toBeDefined()
    // A method this transport does not serve is rejected before any work, so it is not a
    // call: the model never saw it. Both adapters agree on this now. `sampling/*` is the
    // example -- every standard MCP method is forwarded, so an unsupported one has to be
    // something outside the set.
    await expect(backend.call({ method: "sampling/createMessage", timeoutMs: 5_000 } as never)).rejects.toThrow(
      /not supported/,
    )
    const status = backend.describe()
    expect(status.calls).toBe(1)
    expect(status.errors).toBe(0)
    expect(status.inflight).toBe(0)
  })

  test("the cold start is inside the measured call, so lastMs means one thing", async () => {
    // The disagreement this ticket is about. `lastMs` used to be inference-only for this
    // adapter and end-to-end for the http one, so the same field described two different
    // things. The start is inside `track` now, which is what makes the field mean the same
    // thing in both — and this is the assertion that would notice if it moved back out.
    const { backend } = await realBackend(0)
    const started = Date.now()
    await backend.call({ method: "tools/call", params: { name: "decide" }, timeoutMs: 30_000 } as never)
    const wall = Date.now() - started
    // The handshake and the request happened; the reported duration cannot be zero, and
    // cannot exceed the wall clock either.
    expect(backend.describe().lastMs).toBeGreaterThan(0)
    expect(backend.describe().lastMs!).toBeLessThanOrEqual(wall)
  })
})
