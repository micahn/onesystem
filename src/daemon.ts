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
 *
 * Note what this module does not know: how any backend works, and where a model comes
 * from. It assembles a port, hands it to the HTTP front, and takes it apart again.
 */

import type { Config } from "./config.ts"
import { lockPath } from "./config.ts"
import { logger } from "./log.ts"
import { describeError } from "./async.ts"
import { acquire, LockBusy, type Lease } from "./lock.ts"
import { serve, type RunningDaemon } from "./http.ts"
import { Supervisor, type SupervisorDeps } from "./supervisor.ts"
import type { BackendPort } from "./backend/types.ts"
import type { HealthReport } from "./health.ts"
import { probeHealth } from "./health.ts"

const log = logger("daemon")

/**
 * Exit code for "another daemon already holds the lock", so `onesystem start` can tell
 * that apart from "we crashed" and report the holder rather than a bare EADDRINUSE.
 * Duplicated as a literal in the CLI until now; it is a contract between two processes.
 */
export const LOCK_BUSY_EXIT = 3

export interface DaemonOptions extends SupervisorDeps {
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
  /** Supply the port instead of building one. Tests use this to avoid real backends. */
  backends?: BackendPort
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
  const backends = options.backends ?? new Supervisor(config, options)

  let lease: Lease
  try {
    lease = await acquire(lockFile, { port: config.port, backends: backends.names() })
  } catch (err) {
    if (err instanceof LockBusy) {
      log.error("another daemon is already running", { holder: err.holder })
      process.exitCode = LOCK_BUSY_EXIT
      throw new LockBusy(err.holder)
    }
    throw err
  }

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
    //
    // The failures are logged rather than swallowed. A backend that will not quiesce is
    // the difference between a clean exit and a successor finding the GPU still full, and
    // the old `.catch(() => {})` made that invisible.
    await daemon?.close().catch((err) => log.error("http close failed", { error: describeError(err) }))
    await backends.quiesce().catch((err) => log.error("backend quiesce failed", { error: describeError(err) }))
    await lease.release()
    log.info("stopped", { reason })
    resolveFinished()
  }

  try {
    daemon = await serve(config, backends)
  } catch (err) {
    log.error("failed to bind", { error: describeError(err) })
    await lease.release()
    resolveFinished()
    throw err
  }

  // The lock recorded `config.port`, which is not necessarily the port just bound: `port: 0`
  // asks the kernel to choose one, and that is what every test in this repo does. Until the
  // real port is written back, the record is a zero and the steal-safety check that depends
  // on it silently passes. See Lease#record.
  await lease.record(daemon.port)

  // The idle window starts counting from daemon start, but only fires once a model has
  // actually been loaded and then gone quiet. See Supervisor#sweep.
  backends.watchIdle(() => {
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
export async function probe(url: string, timeoutMs?: number): Promise<HealthReport | null> {
  return probeHealth(url, timeoutMs)
}
