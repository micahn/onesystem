/**
 * Test idle and cancellation policy with fake backends. Test start/stop races
 * with a real MCP child so cleanup must release an actual process.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Supervisor } from "../src/supervisor.ts"
import { validate, type Config } from "../src/config.ts"
import { StdioMcpBackend } from "../src/backend/stdio-mcp.ts"
import { BackendError, type Backend } from "../src/backend/types.ts"
import { FakeBackend, HangingBackend } from "./fixtures/fake-backend.ts"

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

/** Poll until a condition holds, so a test never depends on a fixed sleep. */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await Bun.sleep(25)
  }
  throw new Error("condition not met within timeout")
}

function configFor(backends: Record<string, unknown>, extra: Record<string, unknown> = {}): Config {
  return validate(
    {
      idleShutdownSecs: 10,
      idleSweepSecs: 1,
      requestTimeoutSecs: 2,
      backends,
      ...extra,
    },
    "test",
  )
}

function stdio(name: string): Record<string, unknown> {
  return { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] }
}

describe("the backend seam", () => {
  test("a fake backend is enough to run the supervisor", async () => {
    const fake = new FakeBackend()
    const supervisor = new Supervisor(configFor({ fake: stdio("fake") }), {
      createBackend: () => fake,
    })

    expect(supervisor.names()).toEqual(["fake"])
    const result = await supervisor.call("fake", "tools/call", { name: "x" })
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] })
  })

  test("the factory is the only place that switches on transport", async () => {
    // Both adapters are constructible, and the default factory routes between them. If
    // routing were decided per-call, this would need a case here for every transport.
    const config = configFor({ a: stdio("a"), b: { transport: "systemone-http", baseUrl: "http://127.0.0.1:1" } })
    const supervisor = new Supervisor(config)
    expect(supervisor.names()).toEqual(["a", "b"])
    expect(supervisor.snapshot().backends.map((b) => b.transport)).toEqual(["stdio-mcp", "systemone-http"])
  })

  test("an unknown backend names the ones that exist", async () => {
    const supervisor = new Supervisor(configFor({ real: stdio("real") }), {
      createBackend: (name) => new FakeBackend({ name }),
    })
    expect(() => supervisor.get("nope")).toThrow(BackendError)
    expect(() => supervisor.get("nope")).toThrow(/real/)
  })

  test("a disabled backend is not registered at all", () => {
    const supervisor = new Supervisor(configFor({ a: { ...stdio("a"), enabled: false }, b: stdio("b") }), {
      createBackend: (name) => new FakeBackend({ name }),
    })
    expect(supervisor.names()).toEqual(["b"])
  })
})

describe("quiesce during a cold start", () => {
  // The race: a cold load takes 20-54s, and a shutdown can land inside it. The old
  // adapter read `#client` in stop(), which is only set once `connect()` resolves — so it
  // closed nothing, returned, and let the caller release the lock. The load then finished
  // and set state to `warm`, leaving a live process holding VRAM that nothing was
  // accounting for, and a successor daemon could start a second copy into a full GPU.
  //
  // Driven against the real adapter and a real child process, because the bug is about
  // when a spawned process is actually reaped. A fake that records "quiesce was called"
  // would pass whether or not the child survived, which is the entire question.
  test("a child whose handshake completes after a quiesce is torn down, not published", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-race-"))
    dirs.push(dir)
    const marker = join(dir, "child.log")
    const fixture = new URL("./fixtures/slow-mcp.ts", import.meta.url).pathname

    const backend = new StdioMcpBackend("slow", {
      transport: "stdio-mcp",
      command: [process.execPath, fixture],
      env: { FAKE_MCP_MARKER: marker, FAKE_MCP_HANDSHAKE_MS: "1200", FAKE_MCP_LINGER_MS: "30000" },
      startupTimeoutSecs: 30,
      tools: ["decide"],
    })

    // The catch is attached now, not later: a quiesce mid-handshake is *supposed* to make
    // this call fail, and an unhandled rejection before the assertion is reached would
    // fail the test for the wrong reason.
    const call = backend.call({ method: "tools/list", params: {} }).then(
      () => "resolved",
      (err: Error) => err.message,
    )
    // Wait until the child is actually spawned and stalling, so the quiesce lands inside
    // the window rather than before or after it.
    await waitFor(async () => (await lines(marker)).includes("spawned"))
    expect(backend.state).toBe("starting")

    await backend.quiesce()

    // Let the handshake finish, well after quiesce returned.
    await Bun.sleep(2000)
    // The call is refused, not served: the child it was waiting on is gone.
    expect(await call).toMatch(/not connected/)

    // The heart of it. Before the generation counter this was "warm" with a live child.
    expect(backend.state).not.toBe("warm")
    expect(backend.describe().inflight).toBe(0)

    // And the child really is gone: it never got as far as reporting a connection.
    const seen = await lines(marker)
    expect(seen).toContain("handshake-done")
    expect(seen).not.toContain("lingering")
  }, 30_000)

  test("quiesce waits for an in-flight handshake rather than racing past it", async () => {
    // The ordering the whole fix rests on: quiesce must not return while a start it was
    // meant to cancel is still running. A timeout rather than a sleep, so a regression
    // fails as a hang instead of as a slow pass.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-race-"))
    dirs.push(dir)
    const marker = join(dir, "child.log")
    const fixture = new URL("./fixtures/slow-mcp.ts", import.meta.url).pathname

    const backend = new StdioMcpBackend("slow", {
      transport: "stdio-mcp",
      command: [process.execPath, fixture],
      env: { FAKE_MCP_MARKER: marker, FAKE_MCP_HANDSHAKE_MS: "800" },
      startupTimeoutSecs: 30,
      tools: ["decide"],
    })

    const call = backend.call({ method: "tools/list", params: {} }).then(
      () => "resolved",
      () => "refused",
    )
    await waitFor(async () => (await lines(marker)).includes("spawned"))

    const quiesce = backend.quiesce()
    // If quiesce returned before the handshake settled, the child would still be alive
    // here and the state would go warm behind us.
    await quiesce
    expect(backend.state).not.toBe("warm")

    await call
    expect(backend.state).not.toBe("warm")
  }, 30_000)
})

describe("request deadlines", () => {
  test("a call that overruns is rejected with the configured budget", async () => {
    const hanging = new HangingBackend()
    const supervisor = new Supervisor(configFor({ h: stdio("h") }, { requestTimeoutSecs: 0.2 }), {
      createBackend: () => hanging as unknown as Backend,
    })

    const started = Date.now()
    await expect(supervisor.call("h", "tools/call", { name: "x" })).rejects.toThrow(/exceeded/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test("an aborted call stops holding the backend's inflight count", async () => {
    // The reason the deadline is a signal and not just a rejection. When a timeout only
    // rejected, `inflight` stayed above zero and the idle sweep skipped that backend
    // forever: a single wedged call pinned the daemon open, defeating the quiet window
    // the whole project depends on.
    const hanging = new HangingBackend()
    const supervisor = new Supervisor(configFor({ h: stdio("h") }, { requestTimeoutSecs: 5 }), {
      createBackend: () => hanging as unknown as Backend,
    })

    const controller = new AbortController()
    const call = supervisor.call("h", "tools/call", { name: "x" }, controller.signal)
    controller.abort()
    await expect(call).rejects.toThrow()
  })

  test("the adapter is told the budget, not left to its own default", async () => {
    // The MCP SDK's default request timeout is 60s, which is shorter than the 120s this
    // daemon is configured for. Without the budget in the context, a legitimately slow
    // call fails against a timeout nobody chose.
    const fake = new FakeBackend()
    const supervisor = new Supervisor(configFor({ f: stdio("f") }, { requestTimeoutSecs: 7 }), {
      createBackend: () => fake,
    })
    await supervisor.call("f", "tools/call", { name: "x" })
    expect(fake.calls[0]!.timeoutMs).toBe(7000)
    expect(fake.calls[0]!.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("the idle sweep", () => {
  test("a cold backend is never reaped, however long it has been idle", () => {
    const fake = new FakeBackend()
    fake.setState("cold", 999_999)
    const supervisor = new Supervisor(configFor({ f: stdio("f") }), {
      createBackend: () => fake,
    })

    let fired = false
    supervisor.watchIdle(() => {
      fired = true
    })
    supervisor.sweep()

    expect(fake.quiesceCount).toBe(0)
    expect(fired).toBe(false)
  })

  test("a warm, quiet, locally-owned backend is reaped and the daemon is told to exit", () => {
    const fake = new FakeBackend()
    fake.setState("warm", 60_000)
    const supervisor = new Supervisor(configFor({ f: stdio("f") }), {
      createBackend: () => fake,
    })

    let fired = false
    supervisor.watchIdle(() => {
      fired = true
    })
    supervisor.sweep()

    expect(fake.quiesceCount).toBe(1)
    expect(fired).toBe(true)
  })

  test("a busy backend is not reaped out from under its own request", () => {
    const fake = new FakeBackend()
    fake.setState("warm", 60_000)
    fake.busy = true
    const supervisor = new Supervisor(configFor({ f: stdio("f") }), {
      createBackend: () => fake,
    })

    supervisor.watchIdle(() => {})
    supervisor.sweep()
    expect(fake.quiesceCount).toBe(0)
  })

  test("a remote backend is never reaped, however warm it reports itself", () => {
    // `systemone-http` is somebody else's already-running process. Quiescing one would
    // mean killing a service onesystem does not own. It reports `warm` forever, so a
    // naive "is anything warm" check would pin the daemon open for the lifetime of the
    // config. This used to be a transport switch repeated in four places.
    const remote = new FakeBackend({ transport: "systemone-http", local: false })
    remote.setState("warm", 60_000)
    const supervisor = new Supervisor(configFor({ r: { transport: "systemone-http", baseUrl: "http://127.0.0.1:1" } }), {
      createBackend: () => remote,
    })

    let fired = false
    supervisor.watchIdle(() => {
      fired = true
    })
    supervisor.sweep()

    expect(remote.quiesceCount).toBe(0)
    expect(fired).toBe(false)
  })

  test("the callback fires at most once", () => {
    const fake = new FakeBackend()
    const supervisor = new Supervisor(configFor({ f: stdio("f") }), {
      createBackend: () => fake,
    })
    let count = 0
    supervisor.watchIdle(() => {
      count++
    })

    fake.setState("warm", 60_000)
    supervisor.sweep()
    supervisor.sweep()
    supervisor.sweep()

    expect(count).toBe(1)
  })

  test("starting the watch twice does not leave the first interval running", async () => {
    const fake = new FakeBackend()
    fake.setState("warm", 60_000)
    const supervisor = new Supervisor(configFor({ f: stdio("f") }, { idleSweepSecs: 0.05 }), {
      createBackend: () => fake,
    })

    let count = 0
    supervisor.watchIdle(() => {
      count++
    })
    // The old code assigned the timer without clearing a previous one, so the leaked
    // interval kept sweeping a supervisor that was supposed to be idle.
    supervisor.watchIdle(() => {
      count++
    })

    await new Promise((r) => setTimeout(r, 250))
    expect(count).toBe(1)
    expect(fake.quiesceCount).toBe(1)
  })
})
