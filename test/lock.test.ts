/**
 * The single-instance guard.
 *
 * This is the test that matters most, because the guard protects against a race that
 * only appears when things go wrong: several opencode sessions load the plugin at once,
 * all of them decide the service is down, and two daemons start. A sequential test
 * cannot catch that, so the concurrency test fires all the acquires in the same tick
 * and asserts exactly one winner.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquire, inspect, LockBusy, pidAlive } from "../src/lock.ts"

const dirs: string[] = []

async function tempLock(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-lock-"))
  dirs.push(dir)
  return join(dir, "daemon.lock")
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe("single-instance guard", () => {
  test("exactly one of many concurrent acquires wins", async () => {
    const path = await tempLock()

    // Fire them together. Any implementation that checks then acts fails here.
    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, () => acquire(path)),
    )

    const winners = attempts.filter((a) => a.status === "fulfilled")
    const losers = attempts.filter((a) => a.status === "rejected")

    expect(winners.length).toBe(1)
    expect(losers.length).toBe(24)

    // Losers must all report the same live holder, so the caller can say who has it.
    for (const loser of losers) {
      const reason = (loser as PromiseRejectedResult).reason
      expect(reason).toBeInstanceOf(LockBusy)
      expect((reason as LockBusy).holder.alive).toBe(true)
      expect((reason as LockBusy).holder.pid).toBe(process.pid)
    }

    await (winners[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release()
  })

  test("a second acquire while held is refused", async () => {
    const path = await tempLock()
    const first = await acquire(path)
    await expect(acquire(path)).rejects.toBeInstanceOf(LockBusy)
    await first.release()
  })

  test("release frees the lock for the next acquirer", async () => {
    const path = await tempLock()
    const first = await acquire(path)
    await first.release()
    const second = await acquire(path)
    expect((await inspect(path)).pid).toBe(process.pid)
    await second.release()
  })

  test("release is idempotent", async () => {
    const path = await tempLock()
    const lease = await acquire(path)
    await lease.release()
    await lease.release()
    // The file is gone, and a fresh acquirer can take it.
    const next = await acquire(path)
    expect((await inspect(path)).pid).toBe(process.pid)
    await next.release()
  })

  test("a lock left by a dead process is reclaimed", async () => {
    const path = await tempLock()
    // A pid that cannot be alive. This is what SIGKILL leaves behind: the file is
    // there, the owner is not, and without reclaiming it the daemon can never restart.
    await writeFile(path, JSON.stringify({ pid: 0x7ffffffe, startedAt: new Date().toISOString() }))

    const lease = await acquire(path)
    expect((await inspect(path)).pid).toBe(process.pid)
    await lease.release()
  })

  test("a freshly truncated lock file is treated as held, not stale", async () => {
    const path = await tempLock()
    await writeFile(path, '{"pid": 12') // killed mid-write

    // Within the grace window this is indistinguishable from a create in flight, so it
    // must NOT be stolen. Reclaiming it is the bug that let two daemons coexist.
    const holder = await inspect(path)
    expect(holder.state).toBe("unknown")
    expect(holder.alive).toBe(true)
    await expect(acquire(path)).rejects.toBeInstanceOf(LockBusy)
  })

  test("a lock file unreadable past the grace window is reclaimed", async () => {
    const path = await tempLock()
    await writeFile(path, '{"pid": 12') // never completed

    // Age it past the window so it is no longer plausibly a create in flight.
    const old = new Date(Date.now() - 10_000)
    await utimes(path, old, old)

    const holder = await inspect(path)
    expect(holder.state).toBe("stale")
    const lease = await acquire(path)
    expect((await inspect(path)).pid).toBe(process.pid)
    await lease.release()
  })

  test("a read racing an in-progress create does not produce two winners", async () => {
    // The specific race the grace window exists for: the winner has created the file
    // but not yet written its pid, and a loser reads zero bytes.
    const path = await tempLock()
    await writeFile(path, "") // exactly what open(path, "wx") leaves behind

    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => acquire(path)))
    expect(attempts.filter((a) => a.status === "fulfilled").length).toBe(0)
    for (const a of attempts) expect((a as PromiseRejectedResult).reason).toBeInstanceOf(LockBusy)
  })

  test("release does not delete a lock a successor now owns", async () => {
    const path = await tempLock()
    const stale = await acquire(path)

    // Simulate the scenario the guard in release() exists for: we were slow, a
    // successor already reclaimed and re-took the lock, and now we release.
    await writeFile(path, JSON.stringify({ pid: 424242, startedAt: new Date().toISOString() }))
    await stale.release()

    const contents = JSON.parse(await readFile(path, "utf8")) as { pid: number }
    expect(contents.pid).toBe(424242)
  })
})

describe("pidAlive", () => {
  test("true for this process", () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  test("false for nonsense", () => {
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(1.5)).toBe(false)
    expect(pidAlive(NaN)).toBe(false)
  })
})
