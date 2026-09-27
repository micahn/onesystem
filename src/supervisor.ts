/**
 * Backend supervisor: owns when models exist.
 *
 * This is the module that encodes the project's actual requirement, which is easy to
 * state and easy to get wrong:
 *
 *   Loading the plugin must cost plugin memory and nothing else. No model may load
 *   until an agent actually calls a tool. And once traffic stops, everything should
 *   wind down on its own after a long quiet window, so the GPU is not held by a
 *   service nobody is using.
 *
 * So the daemon process itself is cheap (a few MB) and starts immediately, and models
 * are strictly lazy. The idle sweep is what makes the pair work: it stops a backend
 * that has been quiet past the window, and reports back to the daemon that nothing is
 * warm any more, which is the daemon's cue to exit and release the port and lock.
 *
 * `systemone-http` backends are exempt. They are somebody else's already-running
 * process, so "stopping" them would mean killing a service onesystem does not own.
 * Their `state` is permanently `warm`, so a naive "is anything warm" check would pin
 * the daemon open forever; `ownsLocalProcess` is what distinguishes the two.
 */

import type { Config } from "./config.ts"
import { logger } from "./log.ts"
import { StdioMcpBackend } from "./backend/stdio-mcp.ts"
import { SystemOneBackendImpl, systemoneToolList } from "./backend/systemone-http.ts"
import { BackendError, type Backend } from "./backend/types.ts"

const log = logger("supervisor")

/** True when stopping this backend actually releases local resources. */
function ownsLocalProcess(backend: Backend): boolean {
  return backend.transport === "stdio-mcp"
}

export class Supervisor {
  readonly backends = new Map<string, Backend>()
  #timer: NodeJS.Timeout | null = null
  #onIdle: (() => void) | null = null
  #stopping = false
  /**
   * Whether a local backend has ever been warm.
   *
   * Without this the idle sweep would fire its callback on the very first tick, before
   * anything was ever loaded, and the daemon would exit immediately after starting.
   * The daemon is meant to sit idle and cheap until the first request; it is only meant
   * to wind down after it has held something and then let it go quiet.
   */
  #everWarm = false

  constructor(private readonly config: Config) {
    for (const [name, spec] of Object.entries(config.backends)) {
      if (spec.enabled === false) {
        log.info("backend disabled by config", { name })
        continue
      }
      this.backends.set(
        name,
        spec.transport === "stdio-mcp"
          ? new StdioMcpBackend(name, spec)
          : new SystemOneBackendImpl(name, spec),
      )
    }
    log.info("backends registered", {
      names: [...this.backends.keys()],
      lazy: true,
    })
  }

  get(name: string): Backend {
    const backend = this.backends.get(name)
    if (!backend) {
      throw new BackendError(name, `unknown backend; configured: ${[...this.backends.keys()].join(", ") || "none"}`)
    }
    return backend
  }

  /** True while at least one backend holds a local process. */
  anyLocalWarm(): boolean {
    for (const backend of this.backends.values()) {
      if (ownsLocalProcess(backend) && backend.state === "warm") return true
    }
    return false
  }

  /**
   * Begin the idle watch. `onIdle` fires once, when the last locally-owned backend has
   * passed the quiet window.
   */
  startIdleWatch(onIdle: () => void): void {
    this.#onIdle = onIdle
    const intervalMs = this.config.idleSweepSecs * 1000
    this.#timer = setInterval(() => this.sweep(), intervalMs)
    // Never hold the event loop open on our own account; the HTTP server does that.
    this.#timer.unref?.()
  }

  /**
   * One pass of the idle check.
   *
   * A backend is only reaped when it is warm, has no in-flight request, and has been
   * quiet past the window. `state === "starting"` is deliberately not reaped: a cold
   * load in progress is the most expensive thing the process does, and killing it
   * because it has not answered *yet* would guarantee a permanently cold service.
   */
  sweep(): void {
    if (this.#stopping) return
    const now = Date.now()
    const windowMs = this.config.idleShutdownSecs * 1000

    for (const backend of this.backends.values()) {
      if (!ownsLocalProcess(backend)) continue
      if (backend.state !== "warm") continue

      // Observed here rather than at request time on purpose. A backend is only
      // "warm" once its handshake has actually completed, and the sweep is the only
      // place that reliably observes that. Setting it in the request path instead
      // reads the state *before* the forward starts, where a first request always
      // looks cold -- which silently disables idle shutdown for a service that only
      // ever sees one request.
      this.#everWarm = true

      if (backend.inflight > 0) continue
      const idleMs = now - backend.lastActivityAt
      if (idleMs < windowMs) continue

      log.info("idle, stopping backend", { name: backend.name, idleMs })
      void backend.stop().catch((err) => log.error("stop failed", { name: backend.name, error: String(err) }))
    }

    // `stop()` sets state synchronously, so the backend is no longer warm by the time
    // the line above returns. No extra tick is needed.
    if (this.#everWarm && !this.anyLocalWarm()) {
      if (this.#timer) {
        clearInterval(this.#timer)
        this.#timer = null
      }
      const cb = this.#onIdle
      this.#onIdle = null
      cb?.()
    }
  }

  /**
   * Handle one MCP request for a backend.
   *
   * This is the only path that may cause a model to load. Everything about the cold
   * cost lands here, on a call the agent actually made.
   */
  async handle(name: string, method: string, params: Record<string, unknown> | undefined, signal?: AbortSignal) {
    const backend = this.get(name)

    // The systemone adapter answers tools/list from a local table; nothing to start.
    if (backend.transport === "systemone-http" && method === "tools/list") {
      return systemoneToolList()
    }

    const started = Date.now()
    if (backend.state === "cold") {
      log.info("cold start requested", { name, method })
    }
    try {
      const result = await withTimeout(
        backend.forward({ method, params, signal }),
        this.config.requestTimeoutSecs * 1000,
        `${name} ${method}`,
      )
      log.debug("forwarded", { name, method, ms: Date.now() - started })
      return result
    } catch (err) {
      if (err instanceof BackendError) throw err
      throw new BackendError(name, describeUnknown(err))
    }
  }

  /** Stop every locally-owned backend. Used on daemon shutdown. */
  async stopAll(): Promise<void> {
    this.#stopping = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    await Promise.allSettled(
      [...this.backends.values()].filter(ownsLocalProcess).map((b) => b.stop()),
    )
    log.info("all backends stopped")
  }

  /** Status for `onesystem status` and `GET /health`. Loads nothing. */
  snapshot() {
    return {
      anyLocalWarm: this.anyLocalWarm(),
      backends: [...this.backends.values()].map((b) => b.describe()),
    }
  }
}

function describeUnknown(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
