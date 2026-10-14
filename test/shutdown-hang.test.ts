/**
 * A shutdown must settle and release the lock even when a client still holds a connection
 * open.
 *
 * Measured under Bun: `server.close()`'s callback waits for every connection to end, and it
 * stays pending forever when a connection carries an unfinished request or an open SSE
 * response — which is what an idle MCP client does. The daemon used to await that callback
 * before releasing its lock, so one connected-but-idle client turned an idle shutdown into a
 * live process holding `daemon.lock` with nothing listening on the port. Every later start
 * then died with LockBusy, and `onesystem stop` could not clear it either, because it probes
 * /health first. Observed 2026-10-13 on the real daemon, with opencode holding the connection.
 *
 * These tests cover the three ways that state is prevented or cleared: the shutdown cannot
 * hang, a later acquire reclaims a holder that is alive but not serving, and `stop` can reach
 * a daemon that no longer answers.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { connect } from "node:net"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDaemon } from "../src/daemon.ts"
import { acquire, inspect, LockBusy, pidAlive } from "../src/lock.ts"
import { validate, type Config } from "../src/config.ts"
import type { BackendPort } from "../src/backend/types.ts"
import { FakeBackend } from "./fixtures/fake-backend.ts"

const dirs: string[] = []
const cleanups: (() => void)[] = []

afterEach(async () => {
  while (cleanups.length) cleanups.pop()!()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-shutdown-"))
  dirs.push(dir)
  return dir
}

/** A port that was listening a moment ago and is not now. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((r) => server.close(() => r()))
  return port
}

/** A BackendPort with nothing to stop and no idle timer that fires. */
function quietBackends(): BackendPort {
  const fake = new FakeBackend({ name: "rizzo" })
  return {
    names: () => ["rizzo"],
    get: () => fake,
    call: (_name, method, params) => fake.call({ method, params }),
    snapshot: () => ({ backends: [fake.describe()] }),
    anyLocalWarm: () => false,
    watchIdle: () => {},
    quiesce: () => fake.quiesce(),
  }
}

/** Hold a connection open the way an idle client does: a request that never finishes. */
function holdConnection(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      // Headers promise a body that never arrives, so the request stays in flight.
      socket.write("POST /call HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 64\r\n\r\n")
      cleanups.push(() => socket.destroy())
      resolve()
    })
    socket.once("error", reject)
  })
}

function testConfig(): Config {
  return validate({ port: 0, idleShutdownSecs: 300, idleSweepSecs: 5 }, "test")
}

describe("shutdown while a client is still connected", () => {
  test("close() settles and releases the lock instead of hanging", async () => {
    const dir = await tempDir()
    const lockFile = join(dir, "daemon.lock")
    const daemon = await runDaemon(testConfig(), { lockFile, backends: quietBackends(), handleSignals: false })
    await holdConnection(daemon.port)

    // Held while the daemon runs, so the assertion below is about release, not absence.
    expect((await inspect(lockFile)).pid).toBe(process.pid)

    await Promise.race([
      daemon.close(),
      Bun.sleep(8_000).then(() => {
        throw new Error("close() did not settle: a held connection blocked the shutdown")
      }),
    ])

    expect(await readFile(lockFile, "utf8").catch(() => null)).toBeNull()
  }, 20_000)
})

describe("a holder that is alive but not serving", () => {
  test("a later acquire reclaims it, so a hung shutdown cannot lock the daemon out", async () => {
    const dir = await tempDir()
    const lockFile = join(dir, "daemon.lock")
    // This process is the live pid; the recorded port was listening and now is not. That is
    // the exact shape a shutdown that hung after closing its listener leaves behind.
    await writeFile(
      lockFile,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: await closedPort() }),
    )

    const holder = await inspect(lockFile)
    expect(holder.state).toBe("held")
    expect(holder.alive).toBe(true)

    const lease = await acquire(lockFile)
    expect((await inspect(lockFile)).pid).toBe(process.pid)
    await lease.release()
  })

  test("a holder that is serving is still refused", async () => {
    const dir = await tempDir()
    const lockFile = join(dir, "daemon.lock")
    const server = createServer()
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    cleanups.push(() => server.close())
    const port = (server.address() as { port: number }).port
    await writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port }))

    await expect(acquire(lockFile)).rejects.toBeInstanceOf(LockBusy)
  })
})

describe("onesystem stop against a daemon that does not answer", () => {
  test("it stops the pid holding the lock, even when SIGTERM is ignored", async () => {
    const dir = await tempDir()
    const lockFile = join(dir, "daemon.lock")
    // A config pointing at a port nothing serves, so this exercises the fallback rather than
    // reaching a real daemon. The state dir is the temp dir for the same reason.
    const port = await closedPort()
    await writeFile(join(dir, "onesystem.jsonc"), JSON.stringify({ host: "127.0.0.1", port }))

    // A live process that never answers /health and ignores SIGTERM, like a daemon stuck
    // inside a shutdown that already ran its signal handler.
    const phantom = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    })
    cleanups.push(() => phantom.kill("SIGKILL"))
    await writeFile(
      lockFile,
      JSON.stringify({ pid: phantom.pid, startedAt: new Date().toISOString(), port }),
    )

    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, "stop"], {
        env: { ...process.env, ONESYSTEM_STATE_DIR: dir, ONESYSTEM_CONFIG_DIR: dir },
        stdio: ["ignore", "ignore", "ignore"],
      })
      child.on("error", () => resolve(127))
      child.on("close", (c) => resolve(c ?? 1))
    })

    expect(code).toBe(0)
    expect(pidAlive(phantom.pid!)).toBe(false)
    expect(await readFile(lockFile, "utf8").catch(() => null)).toBeNull()
  }, 20_000)
})
