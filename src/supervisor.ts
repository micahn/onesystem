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
 * ## What this module deliberately does not know
 *
 * `systemone-http` backends are somebody else's already-running process, so quiescing one
 * would mean killing a service onesystem does not own. That used to be a
 * `backend.transport === "stdio-mcp"` predicate here, duplicated by the factory switch,
 * by config validation, and by a special case in the request path — four places to
 * update to add a transport. It is now one declaration on the adapter
 * (`BackendStatus#local`), read through `describe()`.
 *
 * Likewise, `tools/list` for the systemone adapter is answered by the adapter. It used to
 * be special-cased here, which meant the supervisor knew one transport's tool surface, and
 * the request path had a branch that only applied to one backend. Adding a third transport
 * would have needed a fourth edit here.
 *
 * The supervisor keeps the *policy* — when it is safe to stop something, when the quiet
 * window has passed — and delegates every mechanism to the adapter.
 */

import type { Backend as BackendSpec, Config } from "./config.ts"
import { describeError, startDeadline, withTimeout } from "./async.ts"
import { logger } from "./log.ts"
import { StdioMcpBackend } from "./backend/stdio-mcp.ts"
import { SystemOneBackendImpl, type FetchLike } from "./backend/systemone-http.ts"
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
   * Whether a local backend has ever been warm.
   *
   * Without this the idle sweep would fire its callback on the very first tick, before
   * anything was ever loaded, and the daemon would exit immediately after starting.
   * The daemon is meant to sit idle and cheap until the first request; it is only meant
   * to wind down after it has held something and then let it go quiet.
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
        return spec.transport === "stdio-mcp"
          ? new StdioMcpBackend(name, spec, { now })
          : new SystemOneBackendImpl(name, spec, { fetch: this.deps.fetch, now })
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
    // Calling this twice used to leak the first interval, which then kept sweeping a
    // supervisor that was supposed to be idle.
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
   * One pass of the idle check.
   *
   * A backend is only reaped when it is warm, has no in-flight request, and has been
   * quiet past the window. `state === "starting"` is deliberately not reaped: a cold
   * load in progress is the most expensive thing the process does, and killing it
   * because it has not answered *yet* would guarantee a permanently cold service.
   *
   * Everything this needs is read from `describe()`, which is the read-only view of a
   * backend's accounting. The sweep does not reach in and touch `lastActivityAt`, so
   * those numbers cannot be corrupted from outside, and a backend's internals are one
   * method rather than a set of public fields.
   */
  sweep(): void {
    if (this.#quiescing) return

    // Entries, not values: a backend's status carries its own `name`, and looking it back
    // up by that name is a second source of truth for something the map already knows.
    // It is also wrong the moment the two disagree, which is a silent no-op rather than a
    // crash that would have been noticed.
    for (const backend of this.#backends.values()) {
      const status = backend.describe()
      if (!status.local) continue
      if (status.state !== "warm") continue

      // Observed here rather than at request time on purpose. A backend is only
      // "warm" once its handshake has actually completed, and the sweep is the only
      // place that reliably observes that. Setting it in the request path instead
      // reads the state *before* the forward starts, where a first request always
      // looks cold -- which silently disables idle shutdown for a service that only
      // ever sees one request.
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
   * Forward one MCP request for a backend.
   *
   * This is the only path that may cause a model to load. Everything about the cold
   * cost lands here, on a call the agent actually made. The deadline is applied here
   * rather than in the adapter because the budget is onesystem's policy, not the
   * transport's — and because a timeout the adapter does not know about is a timeout
   * the adapter cannot honour.
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
      // Two layers on purpose. The signal is the real cancellation: it reaches the
      // transport, so an overrunning call stops holding the backend's inflight count and
      // the backend becomes reapable again. The race is the backstop for an adapter that
      // ignores its signal, so a caller is never left hanging either way.
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
