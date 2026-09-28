/**
 * Single-instance guard using atomic O_CREAT|O_EXCL. The TCP bind is a second guard
 * if the lock file is lost. Reclaim dead-pid records only when their recorded port
 * is not listening; records without a readable port skip that check.
 * Allow a grace period for incomplete writes. Lease.record stores the actual bound
 * port after startup, including when the daemon requested port 0.
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
   * Recorded port. Null for legacy or unreadable records; skips the port check.
   */
  port: number | null
  /** Path to the lock file. */
  path: string
}

/**
 * Grace period for unreadable records. open(path, "wx") creates an empty file
 * before the pid is written; reclaiming it immediately could admit two daemons.
 */
const UNKNOWN_GRACE_MS = 3_000

export interface Lease {
  path: string
  /**
   * Record the actual port after binding. A requested port of 0 cannot be probed.
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

/** True when the pid exists, including when signaling it returns EPERM. */
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
 * Probe by connecting; binding would compete with the daemon for its port.
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

/** Acquire or report the holder. Retry when processes race to reclaim a stale lock. */
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
            // Preserve a successor's record if ownership changed.
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

      // A listening port can belong to a daemon whose pid is not visible here.
      // Keep its lock to prevent a duplicate model process.
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
