/**
 * Acquire the lock before binding, then supervise backends until idle or shutdown.
 * Release the lock on bind failure. On shutdown, close HTTP and stop local backends
 * before releasing the lock so a successor cannot load a duplicate model.
 */

import type { Config } from "./config.ts"
import { lockPath } from "./paths.ts"
import { logger } from "./log.ts"
import { describeError, withTimeout } from "./async.ts"
import { acquire, LockBusy, type Lease } from "./lock.ts"
import { serve, type RunningDaemon } from "./http.ts"
import { Supervisor, type SupervisorDeps } from "./supervisor.ts"
import type { BackendPort } from "./backend/types.ts"
import type { HealthReport } from "./health.ts"
import { probeHealth } from "./health.ts"

const log = logger("daemon")

/**
 * Tell `onesystem start` that another daemon holds the lock; wait for its health.
 */
export const LOCK_BUSY_EXIT = 3

/**
 * Bound each shutdown step. A close that never settles - an unfinished response holding the
 * listener open - must not stop the daemon from releasing its lock, because a live process
 * holding the lock refuses every later start (see lock.ts).
 */
const SHUTDOWN_STEP_TIMEOUT_MS = 10_000

export interface DaemonOptions extends SupervisorDeps {
  /** Override the lock path. Tests use this to stay out of the real state dir. */
  lockFile?: string
  /**
   * Install signal handlers that exit the process. Set false when embedding or testing.
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

  /** One shutdown step, bounded and logged. Nothing here may wait forever. */
  const step = (work: Promise<unknown>, what: string): Promise<void> =>
    withTimeout(work, SHUTDOWN_STEP_TIMEOUT_MS, what)
      .then(() => undefined)
      .catch((err) => log.error(`${what} failed`, { error: describeError(err) }))

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info("shutting down", { reason })
    // Keep the lock until local backends stop. Every step is bounded, because the release
    // below is what lets a successor start: a step that never settled would leave a live
    // process holding the lock, and a live pid alone refuses every later start.
    await step(daemon?.close() ?? Promise.resolve(), "http close")
    await step(backends.quiesce(), "backend quiesce")
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

  // Record the actual port, especially when config.port is 0, for stale-lock checks.
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
