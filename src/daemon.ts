/**
 * Daemon assembly: take the lock, bind, supervise, wind down.
 *
 * Order matters here and is the reason this is a separate file rather than more of
 * `cli.ts`. The lock must be taken *before* the port is bound, so that a second daemon
 * fails on the filesystem with a clear message rather than on the socket with an
 * EADDRINUSE that reads like a networking problem. The port bind then acts as the
 * backstop if the lock is ever lost.
 *
 * Shutdown has three exits, and all of them have to release the lock:
 *
 *   - idle: the supervisor's callback, after the quiet window
 *   - signal: SIGINT/SIGTERM, so `onesystem stop` and Ctrl-C both work
 *   - a child dying unexpectedly, which is reported but not fatal
 *
 * The lock is released in a `finally` and the release is idempotent, so whichever exit
 * wins, the next daemon can take the lock.
 */

import type { Config } from "./config.ts"
import { lockPath } from "./config.ts"
import { logger } from "./log.ts"
import { acquire, LockBusy, type Lease } from "./lock.ts"
import { serve, type RunningDaemon } from "./http.ts"
import { Supervisor } from "./supervisor.ts"

const log = logger("daemon")

export interface DaemonOptions {
  /** Override the lock path. Tests use this to stay out of the real state dir. */
  lockFile?: string
  /**
   * Install SIGINT/SIGTERM handlers that exit the process.
   *
   * On for `onesystem serve`, off when embedded. A signal handler here calls
   * `process.exit`, which is right for a daemon that owns the process and badly wrong
   * for a caller that only borrowed the server: an embedding test that shuts the
   * daemon down with a signal would take its own runner down with it.
   */
  handleSignals?: boolean
}

export interface DaemonHandle {
  url: string
  port: number
  /** Idempotent. Closes the listener, stops backends, releases the lock. */
  close(): Promise<void>
  /** Resolves when the daemon has wound itself down (idle, signal, or close). */
  finished: Promise<void>
}

export async function runDaemon(config: Config, options: DaemonOptions = {}): Promise<DaemonHandle> {
  const lockFile = options.lockFile ?? lockPath()

  let lease: Lease
  try {
    lease = await acquire(lockFile, { port: config.port, backends: Object.keys(config.backends) })
  } catch (err) {
    if (err instanceof LockBusy) {
      // Exit code 3 so `onesystem start` can tell "someone else has it" apart from
      // "we crashed", and report the holder instead of a bare EADDRINUSE.
      log.error("another daemon is already running", { holder: err.holder })
      process.exitCode = 3
      throw new LockBusy(err.holder)
    }
    throw err
  }

  const supervisor = new Supervisor(config)

  let daemon: RunningDaemon | null = null
  let shuttingDown = false
  let resolveFinished!: () => void
  const finished = new Promise<void>((r) => {
    resolveFinished = r
  })

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info("shutting down", { reason })
    // Order: stop answering, stop the models, then drop the lock. Unloading the models
    // first is what actually frees the VRAM, and doing it before releasing the lock
    // means a successor daemon cannot start a second copy into a still-full GPU.
    await daemon?.close().catch(() => {})
    await supervisor.stopAll().catch(() => {})
    await lease.release()
    log.info("stopped", { reason })
    resolveFinished()
  }

  try {
    daemon = await serve(config, supervisor)
  } catch (err) {
    log.error("failed to bind", { error: String(err) })
    await lease.release()
    resolveFinished()
    throw err
  }

  // The idle window starts counting from daemon start, but only fires once a model has
  // actually been loaded and then gone quiet. See Supervisor#sweep.
  supervisor.startIdleWatch(() => {
    void shutdown("idle").then(() => {
      if (options.handleSignals !== false) process.exit(0)
    })
  })

  if (options.handleSignals !== false) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void shutdown(signal).then(() => process.exit(0))
      })
    }
  }

  return {
    url: daemon.url,
    port: daemon.port,
    close: () => shutdown("close"),
    finished,
  }
}

/** Probe a daemon that may or may not be running. Never starts anything. */
export async function probe(url: string, timeoutMs = 1500): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
