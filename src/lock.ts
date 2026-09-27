/**
 * Single-instance guard.
 *
 * The failure this exists to prevent is specific and has already happened on this
 * machine: several opencode sessions each load a plugin, each decides to "make sure
 * the service is up", and two of them start a daemon. Two daemons means two copies of
 * the same model on one GPU, which is the situation this whole project replaces.
 *
 * A check-then-act ("is it running? no? start it") is not enough, because every
 * session runs that check concurrently at startup. The mutual exclusion has to live
 * in the filesystem, where the kernel arbitrates it.
 *
 * Two layers, deliberately:
 *
 *   1. `O_CREAT|O_EXCL` on the lock file. Atomic on any POSIX filesystem, so exactly
 *      one process creates it and the losers learn they lost. This is the real guard.
 *   2. The TCP port bind. If the lock file is somehow lost, deleted by a tmp reaper, or
 *      restored from a backup, only one process can still own the port, so the second
 *      daemon fails loudly at startup instead of silently duplicating the model.
 *
 * Layer 1 alone would be defeated by a stale file after a hard kill (SIGKILL leaves no
 * cleanup handler), so `acquire` reads the recorded pid and steals the lock when that
 * pid is provably gone. Stealing is only safe because the holder's port is also
 * checked: see `Holder`.
 */

import { open, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { logger } from "./log.ts"

const log = logger("lock")

export interface Holder {
  /** pid recorded in the lock file, or null when the file is unreadable. */
  pid: number | null
  /**
   * `held`    - a pid is recorded and alive. Must not start.
   * `stale`   - a pid is recorded and provably gone. Safe to reclaim.
   * `unknown` - the file exists but has no readable record yet.
   */
  state: "held" | "stale" | "unknown"
  /** True when a pid is recorded and alive, or the record is not yet readable. */
  alive: boolean
  /** Path to the lock file. */
  path: string
}

/**
 * How long an unreadable lock file is presumed to be mid-create.
 *
 * `open(path, "wx")` creates the file empty, and the pid is written a moment later.
 * A concurrent reader that opens it inside that window sees zero bytes. Treating that
 * as stale is a real bug, not a theoretical one: the reader deletes the file, creates
 * its own, and two daemons hold "the" lock. So an unreadable record is presumed to be
 * a create in progress until it has sat unparseable for longer than any create window
 * could plausibly last. A create that genuinely wedged is reclaimed after this.
 */
const UNKNOWN_GRACE_MS = 3_000

export interface Lease {
  path: string
  release(): Promise<void>
}

export class LockBusy extends Error {
  constructor(readonly holder: Holder) {
    super(
      holder.pid !== null
        ? `another onesystem daemon holds ${holder.path} (pid ${holder.pid})`
        : `another onesystem daemon is creating ${holder.path}; its pid is not written yet`,
    )
    this.name = "LockBusy"
  }
}

/** True when a pid exists and we may signal it. EPERM means it exists but is not ours. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function readHolder(path: string): Promise<Holder> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return { pid: null, state: "unknown", alive: false, path }
  }

  // Written as JSON so the record can grow (port, startedAt) without breaking older
  // readers, and so a truncated write is detectable rather than parsed as 0.
  let pid: number | null = null
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown }
    if (typeof parsed.pid === "number") pid = parsed.pid
  } catch {
    const legacy = Number.parseInt(raw.trim(), 10)
    if (Number.isInteger(legacy)) pid = legacy
  }

  if (pid === null) {
    // No readable pid. Only stale if it has been sitting unparseable past the grace
    // window; otherwise assume a create is in flight and treat it as held.
    let ageMs = 0
    try {
      ageMs = Date.now() - (await stat(path)).mtimeMs
    } catch {
      return { pid: null, state: "unknown", alive: true, path }
    }
    const settled = ageMs >= UNKNOWN_GRACE_MS
    return { pid: null, state: settled ? "stale" : "unknown", alive: !settled, path }
  }

  const alive = pidAlive(pid)
  return { pid, state: alive ? "held" : "stale", alive, path }
}

/**
 * Take the lock, or report who holds it.
 *
 * Retries the steal path a few times: if we read a lock whose pid is dead, another
 * process is very likely doing the same read at the same moment, and exactly one of
 * us should win the recreate.
 */
export async function acquire(path: string, info: Record<string, unknown> = {}): Promise<Lease> {
  await mkdir(dirname(path), { recursive: true })

  // Three outcomes per pass, and they need different handling:
  //   won      - we created it
  //   unknown  - it exists with no readable record yet, so a create is in flight:
  //              wait it out rather than stealing, and we usually learn the pid
  //   stale    - the recorded pid is gone, or the record stayed unreadable past the
  //              grace window: reap it
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      // O_CREAT|O_EXCL|O_WRONLY. Atomic: the kernel guarantees a single winner.
      const handle = await open(path, "wx")
      const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...info })
      await handle.writeFile(record)
      await handle.close()
      log.info("acquired", { path, pid: process.pid })

      let released = false
      return {
        path,
        release: async () => {
          if (released) return
          released = true
          try {
            // Only unlink if we still own it. If we were killed and a successor
            // already reclaimed the lock, removing it would drop *their* guard.
            const holder = await readHolder(path)
            if (holder.pid === process.pid) await unlink(path)
          } catch {
            /* already gone */
          }
          log.info("released", { path })
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err

      const holder = await readHolder(path)

      if (holder.state === "held") throw new LockBusy(holder)

      if (holder.state === "unknown") {
        // Someone is mid-create. Short wait, then re-read so the eventual LockBusy
        // can name the holder's pid instead of reporting an anonymous lock.
        await new Promise((r) => setTimeout(r, 5 + attempt * 5))
        continue
      }

      log.warn("reclaiming stale lock", { path, pid: holder.pid, holderState: holder.state })
      try {
        await unlink(path)
      } catch {
        /* someone else reaped it first, which is fine */
      }
      await new Promise((r) => setTimeout(r, 10 + attempt * 5))
    }
  }

  throw new LockBusy(await readHolder(path))
}

/** Inspect without acquiring. Used by `onesystem status`. */
export function inspect(path: string): Promise<Holder> {
  return readHolder(path)
}

/** Write a pid file without taking the lock. Only for `start`, which re-execs. */
export async function writePid(path: string, info: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ...info }, null, 2))
}
