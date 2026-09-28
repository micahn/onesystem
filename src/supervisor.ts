/**
 * Own lazy startup, request deadlines, and idle shutdown policy.
 * Only calls may load models. Stop warm local backends after the idle window when
 * no call is in flight; remote services remain independently managed.
 * Adapters implement transport and cleanup. The supervisor reads their status.
 */

import type { Config } from "./config.ts"
import type { BackendSpec } from "./backend/spec.ts"
import { describeError, startDeadline, withTimeout } from "./async.ts"
import { logger } from "./log.ts"
import { StdioMcpBackend } from "./backend/stdio-mcp.ts"
import { SystemOneBackendImpl, type FetchLike } from "./backend/systemone-http.ts"
import { SystemOneServeBackend } from "./backend/systemone-serve.ts"
import { BackendError, type Backend, type BackendPort, type BackendStatus } from "./backend/types.ts"

const log = logger("supervisor")

/** Turn one config entry into a backend. The seam a test replaces. */
export type BackendFactory = (name: string, spec: BackendSpec) => Backend

export interface SupervisorDeps {
  /**
   * How a config entry becomes a backend. Overridden in tests, where a backend has to be
   * something that does not spawn a process and does not talk to the network.
   */
  createBackend?: BackendFactory
  /** Injected into the built-in factory. */
  fetch?: FetchLike
  now?: () => number
}

export class Supervisor implements BackendPort {
  readonly #backends = new Map<string, Backend>()
  #timer: NodeJS.Timeout | null = null
  #onIdle: (() => void) | null = null
  #quiescing = false
  /**
   * Keep a new daemon available until a local backend has been warm at least once.
   */
  #everWarm = false

  constructor(
    private readonly config: Config,
    private readonly deps: SupervisorDeps = {},
  ) {
    // One switch on transport, in one place. A test replaces the whole factory; a new
    // transport is added here and nowhere else in this module.
    const create: BackendFactory =
      this.deps.createBackend ??
      ((name, spec) => {
        const now = this.deps.now
        if (spec.transport === "stdio-mcp") return new StdioMcpBackend(name, spec, { now })
        if (spec.transport === "systemone-serve") {
          return new SystemOneServeBackend(name, spec, { fetch: this.deps.fetch, now })
        }
        return new SystemOneBackendImpl(name, spec, { fetch: this.deps.fetch, now })
      })

    for (const [name, spec] of Object.entries(config.backends)) {
      if (spec.enabled === false) {
        log.info("backend disabled by config", { name })
        continue
      }
      try {
        this.#backends.set(name, create(name, spec))
      } catch (err) {
        // One unusable entry should not cost the user the backends that do work.
        log.error("backend could not be constructed", { name, error: describeError(err) })
      }
    }
    log.info("backends registered", {
      names: [...this.#backends.keys()],
      lazy: true,
    })
  }

  names(): string[] {
    return [...this.#backends.keys()]
  }

  get(name: string): Backend {
    const backend = this.#backends.get(name)
    if (!backend) {
      throw new BackendError(name, `unknown backend; configured: ${this.names().join(", ") || "none"}`)
    }
    return backend
  }

  /** True while at least one backend holds a local process. */
  anyLocalWarm(): boolean {
    return this.#backends.values().some((b) => {
      const status = b.describe()
      return status.local && status.state === "warm"
    })
  }

  /**
   * Begin the idle watch. `onIdle` fires once, when the last locally-owned backend has
   * passed the quiet window.
   */
  watchIdle(onIdle: () => void): void {
    // Replace any existing timer.
    this.stopWatching()
    this.#onIdle = onIdle
    const intervalMs = this.config.idleSweepSecs * 1000
    this.#timer = setInterval(() => this.sweep(), intervalMs)
    // Never hold the event loop open on our own account; the HTTP server does that.
    this.#timer.unref?.()
  }

  private stopWatching(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Stop only local, warm backends with no requests and an expired idle window.
   * A starting backend must finish loading before it can be considered idle.
   */
  sweep(): void {
    if (this.#quiescing) return

    for (const backend of this.#backends.values()) {
      const status = backend.describe()
      if (!status.local) continue
      if (status.state !== "warm") continue

      // Observe after startup. Reading before the first call would see only "cold"
      // and could leave a one-call daemon unable to shut down.
      this.#everWarm = true

      if (status.inflight > 0) continue
      if (status.idleMs < this.config.idleShutdownSecs * 1000) continue

      log.info("idle, stopping backend", { name: status.name, idleMs: status.idleMs })
      void backend
        .quiesce()
        .catch((err) => log.error("stop failed", { name: status.name, error: describeError(err) }))
    }

    // `quiesce()` sets state synchronously, so the backend is no longer warm by the time
    // the line above returns. No extra tick is needed.
    if (this.#everWarm && !this.anyLocalWarm()) {
      this.stopWatching()
      const cb = this.#onIdle
      this.#onIdle = null
      cb?.()
    }
  }

  /**
   * Forward a request, starting a cold backend if needed. Pass the shared request
   * budget and cancellation signal to the adapter.
   */
  async call(
    name: string,
    method: string,
    params: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const backend = this.get(name)
    const timeoutMs = this.config.requestTimeoutSecs * 1000
    const started = Date.now()
    if (backend.state === "cold") {
      log.info("cold start requested", { name, method })
    }

    const deadline = startDeadline(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
    try {
      // Abort the work first. Bound the wait too, in case an adapter ignores cancellation.
      const result = await withTimeout(
        backend.call({ method, params, signal: combined, timeoutMs }),
        timeoutMs + 1000,
        `${name} ${method}`,
      )
      log.debug("forwarded", { name, method, ms: Date.now() - started })
      return result
    } catch (err) {
      if (err instanceof BackendError) throw err
      if (deadline.timedOut()) {
        throw new BackendError(name, `${method} exceeded ${timeoutMs}ms`, err)
      }
      throw new BackendError(name, describeError(err), err)
    } finally {
      deadline.dispose()
    }
  }

  /** Stop every locally-owned backend. Used on daemon shutdown. */
  async quiesce(): Promise<void> {
    this.#quiescing = true
    this.stopWatching()
    await Promise.allSettled(
      [...this.#backends.values()].filter((b) => b.describe().local).map((b) => b.quiesce()),
    )
    log.info("all backends stopped")
  }

  /** Status for `onesystem status` and `GET /health`. Loads nothing. */
  snapshot(): { backends: BackendStatus[] } {
    return { backends: [...this.#backends.values()].map((b) => b.describe()) }
  }
}
