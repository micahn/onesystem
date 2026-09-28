/**
 * Start a `POST /v1/systemone` service and forward calls to it.
 *
 * The same wire shape as `systemone-http`, with the lifecycle that transport deliberately
 * does not have: that one forwards to a service somebody else runs and is permanently warm,
 * this one spawns the process, polls a health route until the weights are loaded, and
 * quiesces it. Without those, a served model would either never be launched or would be
 * killed on every idle sweep, which is the failure this project exists to avoid.
 *
 * Readiness is the health route rather than an MCP handshake, because the service is an
 * ordinary HTTP server. It is polled to `status: "ready"` and not merely to 200, so a
 * server that binds its port before its weights are loaded still counts as starting.
 *
 * The generation counter, the ledger and the cold/warm/failed states are the same as the
 * stdio transport, deliberately: a start that quiesces mid-flight must tear down its own
 * process rather than publish it after shutdown.
 */

import { spawn } from "node:child_process"
import type { ServeBackend } from "./spec.ts"
import { describeError } from "../async.ts"
import { CallLedger } from "./usage.ts"
import { logger } from "../log.ts"
import { BackendError, type Backend, type BackendState, type BackendStatus, type CallContext } from "./types.ts"

const log = logger("systemone-serve")

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
export type SpawnLike = typeof spawn

export class SystemOneServeBackend implements Backend {
  readonly transport = "systemone-serve" as const
  /** Stopping this releases a process onesystem owns, so the idle sweep counts it. */
  readonly local = true

  #state: BackendState = "cold"
  #child: ReturnType<typeof spawn> | null = null
  #starting: Promise<void> | null = null
  #ledger: CallLedger
  /** Bumped by every quiesce; a start under an older generation must not publish a child. */
  #generation = 0
  #exited: Error | null = null

  constructor(
    readonly name: string,
    private readonly spec: ServeBackend,
    // `spawn` is injectable for the same reason `fetch` is: a runtime that cannot execute
    // its command is a real failure path, and Bun's test runner reports any failed spawn
    // as a test failure even when the error is caught, so it cannot be provoked in-process.
    private readonly deps: { fetch?: FetchLike; spawn?: SpawnLike; now?: () => number } = {},
  ) {
    this.#ledger = new CallLedger(() => this.#now())
  }

  #now(): number {
    return (this.deps.now ?? Date.now)()
  }

  #fetch(): FetchLike {
    return this.deps.fetch ?? ((input, init) => fetch(input, init))
  }

  get state(): BackendState {
    return this.#state
  }

  get toolPrefix(): string | undefined {
    return this.spec.toolPrefix
  }

  /** Declared in config, so `/catalog` answers without loading weights. */
  get tools(): readonly string[] {
    return this.spec.tools
  }

  async start(): Promise<void> {
    if (this.#state === "warm") return
    if (this.#starting) return this.#starting

    this.#state = "starting"
    this.#ledger.touch()
    const generation = this.#generation
    this.#starting = this.#doStart(generation).finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async #doStart(generation: number): Promise<void> {
    const timeoutMs = (this.spec.startupTimeoutSecs ?? 300) * 1000
    const started = this.#now()
    const command = this.spec.command[0]!
    log.info("spawning", { command, cwd: this.spec.cwd, timeoutMs })

    // Whether a bad executable throws here or arrives as an "error" event differs between
    // runtimes -- Bun throws under its test runner and emits under a plain script -- so both
    // are handled, and the message names the program either way.
    let child: ReturnType<typeof spawn>
    try {
      child = (this.deps.spawn ?? spawn)(command, this.spec.command.slice(1), {
        // Some servers resolve their weights and their own runtime relative to where they
        // were started, so the cwd is part of the contract rather than a convenience.
        cwd: this.spec.cwd,
        env: { ...(process.env as Record<string, string>), ...(this.spec.env ?? {}) },
        // The child's stderr is the only place its own diagnostics can go. Inherit it so a
        // failed load is visible rather than silent, as it is for the stdio transport.
        stdio: ["ignore", "ignore", "inherit"],
        detached: false,
      })
    } catch (err) {
      this.#state = "failed"
      throw new BackendError(this.name, `could not execute ${command}: ${describeError(err)}`, err)
    }
    this.#child = child
    this.#exited = null

    // Attached before anything can throw. A child that fails to spawn emits "error" with
    // nothing listening, which is an unhandled event and takes the daemon down rather
    // than failing one backend.
    //
    // A process that dies before readiness must also fail the start, not leave us polling
    // a port nothing will ever answer on.
    const died = new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(err))
      child.once("exit", (code, signal) =>
        reject(new Error(`exited during startup with code ${code ?? "null"} signal ${signal ?? "none"}`)),
      )
    })

    // A binary that cannot be executed leaves pid undefined and never emits "exit", so
    // the health poll would keep asking a service that does not exist and time out for a
    // reason that has nothing to do with startup. Fail on the spawn itself instead.
    if (child.pid === undefined) {
      this.#child = null
      this.#state = "failed"
      throw new BackendError(this.name, `could not execute ${command}: no such executable`)
    }

    try {
      await withStartupTimeout(Promise.race([this.#awaitReady(), died]), timeoutMs, `start ${this.name}`)
    } catch (err) {
      await this.#kill(child)
      this.#child = null
      this.#state = "failed"
      throw new BackendError(
        this.name,
        `failed to start within ${timeoutMs / 1000}s: ${describeError(err)}`,
        err,
      )
    }

    if (generation !== this.#generation) {
      this.#state = "cold"
      await this.#kill(child)
      this.#child = null
      log.info("discarded a start that was quiesced mid-startup", { name: this.name })
      return
    }

    this.#state = "warm"
    this.#ledger.touch()
    log.info("warm", { startupMs: this.#now() - started })
  }

  /**
   * Poll the health route until it reports ready.
   *
   * A 200 is not enough: a server can bind its port before its weights are loaded, so the
   * body has to say `status: "ready"`. Poll errors are expected while the process is still
   * coming up and are retried until the budget runs out.
   */
  async #awaitReady(): Promise<void> {
    const url = `${this.spec.baseUrl.replace(/\/+$/, "")}${this.spec.healthPath ?? "/health"}`
    const fetch = this.#fetch()
    const deadline = Date.now() + (this.spec.startupTimeoutSecs ?? 300) * 1000

    for (;;) {
      if (Date.now() > deadline) throw new Error(`${url} did not report ready`)
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
        if (res.ok) {
          const body = (await res.json()) as { status?: string }
          if (body.status === "ready") return
        }
      } catch {
        // Not listening yet, most likely.
      }
      await Bun.sleep(500)
    }
  }

  async #kill(child: ReturnType<typeof spawn>): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
      // A process that failed to spawn emits "error" and never "exit". Waiting for the
      // exit alone would hang forever on a mistyped command, which is the one case where
      // there is provably nothing to wait for.
      child.once("error", () => resolve())
    })
    child.kill("SIGTERM")
    // A child that ignores SIGTERM should not block shutdown, and cannot hold the port.
    const killer = setTimeout(() => child.kill("SIGKILL"), 5_000)
    killer.unref?.()
    await exited
    clearTimeout(killer)
  }

  /**
   * Release the process, and wait until it is actually released.
   *
   * Waiting on an in-flight start is the point: a caller that returns here must not be
   * surprised by a process appearing later.
   */
  async quiesce(): Promise<void> {
    this.#generation++
    this.#state = "stopping"

    const starting = this.#starting
    if (starting) await starting.catch(() => {})

    const child = this.#child
    this.#child = null
    this.#state = "cold"
    if (!child) return
    try {
      await this.#kill(child)
      log.info("stopped")
    } catch (err) {
      log.warn("stop failed, continuing", { error: describeError(err) })
    }
  }

  async call(ctx: CallContext): Promise<unknown> {
    // Only the two methods this transport can serve. Anything else is not a call and gets
    // no duration and no error count, the same rule the stdio transport follows.
    if (ctx.method !== "tools/call") {
      throw new BackendError(
        this.name,
        `method not supported over the serve bridge: ${ctx.method} (supported: tools/call)`,
      )
    }
    const args = (ctx.params as { arguments?: Record<string, unknown> } | undefined)?.arguments
    if (!args || typeof args.state !== "string" && typeof args.state !== "object") {
      throw new BackendError(this.name, `tools/call needs a "state" argument`)
    }
    const questions = args.questions
    if (!questions || typeof questions !== "object") {
      throw new BackendError(this.name, `tools/call needs a "questions" argument`)
    }

    try {
      return await this.#ledger.track(async () => {
        await this.start()
        const body = await this.#post(args, ctx)
        // An MCP client is waiting on the far side, so the service's JSON has to be
        // dressed as a tool result. The raw payload is kept as structured content too,
        // which is what makes a distribution usable without re-parsing the text.
        return {
          content: [{ type: "text", text: JSON.stringify(body) }],
          structuredContent: body,
          isError: false,
        }
      }, ctx.params)
    } catch (err) {
      if (ctx.signal?.aborted) {
        throw new BackendError(this.name, `${ctx.method} was cancelled: ${describeError(err)}`, err)
      }
      throw new BackendError(this.name, `${ctx.method} failed: ${describeError(err)}`, err)
    }
  }

  async #post(args: Record<string, unknown>, ctx: CallContext): Promise<unknown> {
    const url = `${this.spec.baseUrl.replace(/\/+$/, "")}${this.spec.systemonePath ?? "/v1/systemone"}`
    const res = await this.#fetch()(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // The service selects a model by name and has no default, so the config has to say
        // which one. This is the whole of the shape difference.
        model: this.spec.model,
        state: args.state,
        questions: args.questions,
      }),
      signal: ctx.signal,
    })
    if (!res.ok) {
      // The service answers 422 with a per-field detail on a malformed request, which is
      // the most useful thing it could say; pass it through rather than a bare status.
      const detail = await res.text().catch(() => "")
      throw new Error(`HTTP ${res.status} from ${url}: ${detail.slice(-400)}`)
    }
    return await res.json()
  }

  describe(): BackendStatus {
    return {
      name: this.name,
      transport: this.transport,
      state: this.#state,
      local: true,
      inflight: this.#ledger.inflight,
      idleMs: this.#now() - this.#ledger.lastActivityAt,
      ...this.#ledger.usage,
    }
  }
}

/**
 * Bound the whole spawn-plus-ready wait. The caller kills the child on timeout.
 */
function withStartupTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
    timer.unref?.()
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
