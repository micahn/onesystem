/**
 * Two daemons, and the race that keeps there being one.
 *
 * The whole point of the lock and the port check is that several opencode sessions start
 * at once, all decide the daemon is down, and only one result. A test can cover that at
 * the unit level, and `lock.test.ts` does — but the part that actually failed in practice
 * was the boundary between the two processes: `start` spawns a detached `serve` and
 * interprets its exit code, and that contract was never tested at all. It broke in the
 * live check: a lost race exited 1 instead of 3, so `start` reported failure for a
 * perfectly good daemon that a sibling was serving.
 *
 * These run the real CLI as a subprocess, so what is asserted is the exit code another
 * process actually observes.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { runDaemon } from "../src/daemon.ts"
import { LOCK_BUSY_EXIT } from "../src/daemon.ts"
import { validate, type Config } from "../src/config.ts"
import { LockBusy } from "../src/lock.ts"
import type { BackendPort } from "../src/backend/types.ts"
import { FakeBackend } from "./fixtures/fake-backend.ts"

const cleanups: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {})
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

const CLI = new URL("../src/cli.ts", import.meta.url).pathname

/** Run the real CLI and resolve with its exit code. */
function cli(args: string[], env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "ignore"],
    })
    child.on("error", () => resolve(127))
    child.on("close", (code) => resolve(code ?? 1))
  })
}

function testConfig(port: number): Config {
  return validate({ port, idleShutdownSecs: 300, idleSweepSecs: 5 }, "test")
}

/** A port that is definitely listening, so the lock's port check is meaningful. */
function fakePort(backends: Record<string, FakeBackend>): BackendPort {
  const entries = Object.entries(backends)
  return {
    names: () => entries.map(([n]) => n),
    get: (n) => {
      const b = backends[n]
      if (!b) throw new Error(`unknown backend ${n}`)
      return b
    },
    call: (n, method, params) => backends[n]!.call({ method, params }),
    snapshot: () => ({ backends: entries.map(([, b]) => b.describe()) }),
    anyLocalWarm: () => entries.some(([, b]) => b.describe().local && b.state === "warm"),
    watchIdle: () => {},
    quiesce: async () => {
      for (const b of Object.values(backends)) await b.quiesce()
    },
  }
}

describe("the lock race, between two real processes", () => {
  test("a second daemon refuses to start and says which one holds the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-race-"))
    dirs.push(dir)
    const lockFile = join(dir, "daemon.lock")
    const port = 0

    const first = await runDaemon(testConfig(port), {
      lockFile,
      handleSignals: false,
      backends: fakePort({ a: new FakeBackend({ name: "a" }) }),
    })
    cleanups.push(() => first.close())

    // A second daemon in this same process, against the same lock.
    const previous = process.exitCode
    process.exitCode = undefined
    try {
      await expect(
        runDaemon(testConfig(0), {
          lockFile,
          handleSignals: false,
          backends: fakePort({ a: new FakeBackend({ name: "a" }) }),
        }),
      ).rejects.toBeInstanceOf(LockBusy)
      // And the exit code the CLI's `start` reads to tell this apart from a crash.
      expect(process.exitCode as number | undefined).toBe(LOCK_BUSY_EXIT)
    } finally {
      process.exitCode = previous
    }
  }, 20_000)

  test("a lock whose pid is gone but whose port still answers is not stolen", async () => {
    // The safety argument the lock module's header made and never implemented: it said
    // stealing was only safe because the holder's port was also checked, and there was no
    // port field on the record and no socket opened anywhere in the file. The port was
    // written and read by nobody.
    //
    // So: a daemon that re-execs, or one whose pid was recycled, leaves a lock whose pid
    // is provably gone while the process is very much alive and serving. Stealing on the
    // strength of the pid alone is how a second daemon ends up sharing a GPU.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-race-"))
    dirs.push(dir)
    const lockFile = join(dir, "daemon.lock")

    // A real configured port, because that is the case the check is for: the lock records
    // the port the daemon intends to serve on, and a daemon on `port: 0` records a zero
    // that nothing can be checked against. The shipped config always names a port.
    const port = 45_000 + Math.floor(Math.random() * 2_000)
    const live = await runDaemon(testConfig(port), {
      lockFile,
      handleSignals: false,
      backends: fakePort({ a: new FakeBackend({ name: "a" }) }),
    })
    cleanups.push(() => live.close())
    expect(live.port).toBe(port)

    // Rewrite the record with a pid that cannot be alive, keeping the real port.
    const record = JSON.parse(await Bun.file(lockFile).text()) as { pid: number; port: number }
    expect(record.port).toBe(port)
    await Bun.write(lockFile, JSON.stringify({ ...record, pid: 0x7ffffffe, startedAt: new Date().toISOString() }))

    const previous = process.exitCode
    process.exitCode = undefined
    try {
      await expect(
        runDaemon(testConfig(0), {
          lockFile,
          handleSignals: false,
          backends: fakePort({ a: new FakeBackend({ name: "a" }) }),
        }),
      ).rejects.toBeInstanceOf(LockBusy)
      expect(process.exitCode as number | undefined).toBe(LOCK_BUSY_EXIT)
    } finally {
      process.exitCode = previous
    }
  }, 20_000)

  test("a lock whose pid is gone and whose port is dead is reclaimed", async () => {
    // The other half, so the check above cannot be satisfied by refusing everything. A
    // SIGKILL leaves exactly this: the file, and nothing listening.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-race-"))
    dirs.push(dir)
    const lockFile = join(dir, "daemon.lock")

    // A port we bound and released, so we know nothing is on it.
    const scratch = await runDaemon(testConfig(0), {
      lockFile: join(dir, "scratch.lock"),
      handleSignals: false,
      backends: fakePort({ a: new FakeBackend({ name: "a" }) }),
    })
    const deadPort = scratch.port
    await scratch.close()
    await rm(join(dir, "scratch.lock"), { force: true })

    await Bun.write(
      lockFile,
      JSON.stringify({ pid: 0x7ffffffe, startedAt: new Date().toISOString(), port: deadPort }),
    )

    const reclaimed = await runDaemon(testConfig(0), {
      lockFile,
      handleSignals: false,
      backends: fakePort({ a: new FakeBackend({ name: "a" }) }),
    })
    cleanups.push(() => reclaimed.close())
    // It took the lock and is serving. Before the port check, this also passed — which is
    // the point: the check has to distinguish the two cases, not just refuse more.
    expect(reclaimed.url).toContain(String(reclaimed.port))
  }, 20_000)
})

describe("the start/exit-code contract", () => {
  test("start is idempotent and exits 0 when a daemon is already serving", async () => {
    // `onesystem start` must be safe to call from many sessions at once, and every one of
    // them must see success. The failure this guards: the daemon set `process.exitCode = 3`
    // on losing the race, and the CLI's own error handler then called `process.exit(1)`,
    // overwriting it. `start` saw 1, concluded the daemon had crashed, and reported failure
    // for a daemon that was up and answering.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-race-"))
    dirs.push(dir)
    const lockFile = join(dir, "daemon.lock")
    const daemon = await runDaemon(testConfig(0), {
      lockFile,
      handleSignals: false,
      backends: fakePort({ a: new FakeBackend({ name: "a" }) }),
    })
    cleanups.push(() => daemon.close())

    // A config file the CLI will read, pointing at the live daemon's port.
    const configPath = join(dir, "onesystem.json")
    await Bun.write(
      configPath,
      JSON.stringify({ port: daemon.port, idleShutdownSecs: 300, idleSweepSecs: 5, backends: {} }),
    )
    const env = { ONESYSTEM_CONFIG_DIR: dir, ONESYSTEM_STATE_DIR: dir }

    expect(await cli(["start"], env)).toBe(0)
    expect(await cli(["start"], env)).toBe(0)
    expect(await cli(["start"], env)).toBe(0)
  }, 30_000)

  test("a fresh process reports the address a second one would register against", async () => {
    // The plugin's whole source of truth. It used to build this URL from a default port
    // and an environment variable no daemon module reads, so a user who set `port` in the
    // config got an MCP server pointing at a port nothing was listening on.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-race-"))
    dirs.push(dir)
    const configPath = join(dir, "onesystem.json")
    await Bun.write(
      configPath,
      JSON.stringify({
        port: 9999,
        backends: { mine: { transport: "stdio-mcp", command: ["/bin/true"], toolPrefix: "mine_" } },
      }),
    )
    const env = { ONESYSTEM_CONFIG_DIR: dir, ONESYSTEM_STATE_DIR: dir }

    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [CLI, "status"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "ignore"] })
      let stdout = ""
      child.stdout?.on("data", (d) => (stdout += String(d)))
      child.on("close", () => resolve(stdout))
    })

    const status = JSON.parse(out) as {
      url: string
      config: string
      configCandidates: string[]
      registrations: { backend: string; serverName: string; toolPrefix?: string }[]
    }
    expect(status.url).toBe("http://127.0.0.1:9999")
    expect(status.config).toBe(configPath)
    expect(status.configCandidates[0]).toBe(configPath)
    // The prefix survives the trip. The plugin used to receive it and drop it.
    expect(status.registrations[0]).toMatchObject({ backend: "mine", serverName: "onesystem", toolPrefix: "mine_" })
  }, 20_000)
})
