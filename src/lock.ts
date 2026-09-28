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
 * pid is provably gone.
 *
 * Stealing is only safe because the holder's port is also checked. A dead pid with a live
 * listener means the daemon is serving under a pid we cannot see, and reclaiming on the
 * strength of the pid alone is exactly how two daemons end up sharing a GPU.
 *
 * That check was documented here and implemented nowhere for a long time, and when it was
 * implemented it worked for exactly one configuration. The record is written before the
 * listener binds — it has to be, since the lock is what stops two daemons racing for the
 * port — so it held the port the daemon *intended* to use. `port: 0` means "let the kernel
 * pick", so such a record held a zero: `servingOn(0)` connects nowhere, returns false, and
 * the steal proceeded on the pid alone, silently, in the one configuration the project
 * itself prefers. `Lease#record` closes that, so the value is the bound port rather than
 * the requested one.
 *
 * The same principle the grace window above establishes — "we cannot tell" is not "it is
 * gone" — is why an unreadable port skips the check rather than failing it. A record we
 * cannot read is a lock we do not understand, and refusing to reclaim those would wedge the
 * daemon behind a lock file nobody can clear.
 */

import { open, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises"
import { connect } from "node:net"
import { dirname } from "node:path"
import { describeError } from "./async.ts"
import { logger } from "./log.ts"

const log = logger("lock")

export interface Holder {
  /** pid recorded in the lock file, or null when the file is unreadable. */
  pid: number | null
  /**
   * `held`    - a pid is recorded and alive. Must not start.
   * `stale`   - a pid is recorded and provably gone. Reclaimable, subject to the port.
   * `unknown` - the file exists but has no readable record yet.
   */
  state: "held" | "stale" | "unknown"
  /** True when a pid is recorded and alive, or the record is not yet readable. */
  alive: boolean
  /**
   * Port the holder is serving on, from the record. `null` for a lock written by an
   * older version, or one whose record could not be read — in which case the port check
   * is skipped and only the pid is trusted.
   */
  port: number | null
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
  /**
   * Record the port actually bound, now it is known.
   *
   * The record is written at acquire time, which is *before* the listener binds — and it
   * has to be, because the lock is what stops two daemons racing for the port at all. So
   * the value written then is the port the daemon intends to use, which is not necessarily
   * the one it got: `port: 0` means "let the kernel pick", and every test in this repo uses
   * it. A lock holding `0` can never be checked, so `servingOn(0)` connects to a meaningless
   * port, returns false, and the steal proceeds on the pid alone — turning off the exact
   * check the steal is only safe because of.
   *
   * So the caller reports the real port back once the listener is up. After that the
   * recorded port is a fact rather than an intention, and the steal check works for a
   * daemon that asked the kernel for a port as well as one that named it.
   */
  record(port: number): Promise<void>
  release(): Promise<void>
}

export class LockBusy extends Error {
  constructor(readonly holder: Holder) {
    super(
      holder.pid !== null
        ? `another onesystem daemon holds ${holder.path} (pid ${holder.pid}` +
          (holder.port !== null ? `, serving on port ${holder.port})` : ")")
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

/**
 * Is something listening on a loopback port?
 *
 * A connect, not a bind: binding would itself be a lock, and would race with the daemon
 * we are trying to detect. A refused connection is the answer we want, and it is fast.
 */
function servingOn(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ port, host })
    const settle = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => settle(false))
    socket.once("connect", () => settle(true))
    socket.once("error", (err) => {
      log.debug("port check", { port, host, error: describeError(err) })
      settle(false)
    })
  })
}

async function readHolder(path: string): Promise<Holder> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return { pid: null, state: "unknown", alive: false, port: null, path }
  }

  // Written as JSON so the record can grow (port, startedAt) without breaking older
  // readers, and so a truncated write is detectable rather than parsed as 0.
  let pid: number | null = null
  let port: number | null = null
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown }
    if (typeof parsed.pid === "number") pid = parsed.pid
    if (typeof parsed.port === "number" && Number.isInteger(parsed.port)) port = parsed.port
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
      return { pid: null, state: "unknown", alive: true, port, path }
    }
    const settled = ageMs >= UNKNOWN_GRACE_MS
    return { pid: null, state: settled ? "stale" : "unknown", alive: !settled, port, path }
  }

  const alive = pidAlive(pid)
  return { pid, state: alive ? "held" : "stale", alive, port, path }
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
      const startedAt = new Date().toISOString()
      let extra = info
      const write = async () => {
        await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt, ...extra }))
      }
      await write()
      await handle.close()
      log.info("acquired", { path, pid: process.pid })

      let released = false
      return {
        path,
        record: async (port: number) => {
          if (released) return
          try {
            const current = await readHolder(path)
            // Only rewrite our own record. A successor that already reclaimed the lock owns
            // that file now, and overwriting it with our pid would strand their guard and
            // leave a lock nobody can ever take.
            if (current.pid !== process.pid) return
            extra = { ...extra, port }
            await writeFile(path, JSON.stringify({ pid: process.pid, startedAt, ...extra }))
            log.debug("recorded bound port", { path, port })
          } catch (err) {
            // Not fatal. A lock we cannot update still stops concurrent daemons; it just
            // cannot be port-checked, which is the same position a legacy record is in.
            log.warn("could not record the bound port", { path, error: describeError(err) })
          }
        },
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

      // A dead pid is not sufficient grounds on its own. If the recorded port still
      // answers, the daemon is serving under a pid we cannot see, and taking the lock
      // would start a second daemon against a GPU the first one is holding. This is the
      // check the module header has always claimed; it needs the port the record has
      // always carried.
      if (holder.port !== null && (await servingOn(holder.port))) {
        log.warn("lock holder has a dead pid but is serving", { path, pid: holder.pid, port: holder.port })
        throw new LockBusy(holder)
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
