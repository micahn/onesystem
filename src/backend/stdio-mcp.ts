/**
 * MCP-over-stdio backend.
 *
 * Spawns a local process, completes the MCP `initialize` handshake, and forwards
 * methods to it. This is the `laya` path, and it keeps every bit of the GPU-specific
 * behaviour that already works: the shim owns interpreter selection (ROCm torch vs the
 * mise build), the idle-unload watchdog, and the per-call timeout. onesystem does not
 * reimplement any of that, it just supervises the process.
 *
 * The reason the start is slow is worth stating, because it looks like a hang and gets
 * diagnosed as one. `laya-mcp-idle-server` imports `laya.router`, which pulls in
 * transformers, measured here at 25-30s, and it does that before it binds stdio. So the
 * child is silent for ~30s after spawn. `startupTimeoutSecs` defaults to 180 because of
 * that silence, not because the work is slow.
 *
 * ## The stop/start race
 *
 * A cold load takes 20-54s, which is a long time for a shutdown to overlap with. The
 * original code read `this.#client` in `stop()`, but that field is only assigned once
 * `connect()` has resolved — so a stop arriving during a load closed nothing, returned
 * immediately, and let the caller release the lock and exit. Thirty seconds later the
 * handshake finished, set the state to `warm`, and left a live process holding VRAM that
 * nothing was accounting for. A successor daemon could then start a second copy into a
 * GPU the first one was still sitting in, which is the exact failure this project exists
 * to prevent.
 *
 * The fix is a generation counter rather than a flag, because a flag would have to be
 * reset for the idle sweep's reaping (which quiesces a backend and expects a later call
 * to start it again) and a reset flag is a race waiting to happen. A quiesce bumps the
 * generation; a start records the generation it began under and refuses to publish a
 * client that the generation has moved past.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  CallToolResultSchema,
  CompleteResultSchema,
  EmptyResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { StdioBackend } from "../config.ts"
import { describeError } from "../async.ts"
import { emptyUsage, record } from "./usage.ts"
import { logger } from "../log.ts"
import { BackendError, type Backend, type BackendState, type BackendStatus, type CallContext } from "./types.ts"

const log = logger("stdio-mcp")

/**
 * MCP method -> the SDK schema that validates its result.
 *
 * `Client.request` needs a real zod schema for the second argument; it calls
 * `safeParse` on whatever it is given. Passing a pass-through function looks like it
 * works and fails at runtime on the first call, so each forwarded method is mapped to
 * the schema the SDK publishes for it. An unmapped method is refused rather than
 * forwarded blind, because a wrong schema would reject a valid response and turn a
 * working backend into an unexplained error.
 */
const RESULT_SCHEMAS = {
  "tools/list": ListToolsResultSchema,
  "tools/call": CallToolResultSchema,
  "prompts/list": ListPromptsResultSchema,
  "prompts/get": GetPromptResultSchema,
  "resources/list": ListResourcesResultSchema,
  "resources/templates/list": ListResourceTemplatesResultSchema,
  "resources/read": ReadResourceResultSchema,
  "completion/complete": CompleteResultSchema,
  "logging/setLevel": EmptyResultSchema,
  ping: EmptyResultSchema,
} as const

type ForwardedMethod = keyof typeof RESULT_SCHEMAS

export class StdioMcpBackend implements Backend {
  readonly transport = "stdio-mcp" as const
  /** Stopping this releases a process onesystem owns, so the idle sweep counts it. */
  readonly local = true

  #state: BackendState = "cold"
  #client: Client | null = null
  #starting: Promise<void> | null = null
  #lastActivityAt = Date.now()
  #inflight = 0
  #usage = emptyUsage()
  /**
   * Bumped by every quiesce. A start that began under an older generation is stale, and
   * must tear its own child down rather than publish it.
   */
  #generation = 0

  constructor(
    readonly name: string,
    private readonly spec: StdioBackend,
    private readonly deps: { now?: () => number } = {},
  ) {}

  #now(): number {
    return (this.deps.now ?? Date.now)()
  }

  get state(): BackendState {
    return this.#state
  }

  get toolPrefix(): string | undefined {
    return this.spec.toolPrefix
  }

  /**
   * Declared in config, never asked of the child. See `Backend#tools` for why the two
   * facts cannot be the same one: reading this from the process would make session start
   * pay the model load, which is the whole thing the supervisor exists to avoid.
   */
  get tools(): readonly string[] {
    return this.spec.tools
  }

  /**
   * Start the child and complete the handshake. Lazy, expensive, and idempotent:
   * concurrent callers share one start, and an already-warm backend is a no-op.
   */
  async start(): Promise<void> {
    if (this.#state === "warm") return
    if (this.#starting) return this.#starting

    this.#state = "starting"
    this.#lastActivityAt = this.#now()
    const generation = this.#generation
    this.#starting = this.#doStart(generation).finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async #doStart(generation: number): Promise<void> {
    const timeoutMs = (this.spec.startupTimeoutSecs ?? 180) * 1000
    const started = this.#now()
    log.info("spawning", { command: this.spec.command[0], timeoutMs })

    const transport = new StdioClientTransport({
      command: this.spec.command[0]!,
      args: this.spec.command.slice(1),
      cwd: this.spec.cwd,
      env: { ...(process.env as Record<string, string>), ...(this.spec.env ?? {}) },
      stderr: "inherit",
    })

    const client = new Client({ name: `onesystem:${this.name}`, version: "0.1.0" }, { capabilities: {} })

    try {
      // Bound the whole spawn-plus-handshake. Without this the SDK's default is long
      // enough that a wedged child looks like a hung request rather than a failed start.
      await withStartupTimeout(client.connect(transport), timeoutMs, `connect ${this.name}`)
    } catch (err) {
      // Tear the half-open child down; leaving it would strand VRAM and the port.
      await client.close().catch(() => {})
      this.#state = "failed"
      throw new BackendError(
        this.name,
        `failed to start within ${timeoutMs / 1000}s: ${describeError(err)}`,
        err,
      )
    }

    // A quiesce landed while the handshake was in flight. It has already returned, and
    // the caller believes everything is stopped, so publishing the client now would be a
    // lie with a live process attached. Tear it down instead.
    if (generation !== this.#generation) {
      this.#state = "cold"
      await client.close().catch(() => {})
      log.info("discarded a start that was quiesced mid-handshake", { name: this.name })
      return
    }

    this.#client = client
    this.#state = "warm"
    this.#lastActivityAt = this.#now()
    log.info("warm", { startupMs: this.#now() - started })
  }

  /**
   * Release the child, and wait until it is actually released.
   *
   * Waiting on an in-flight start is the point. A caller that quits after this returns
   * will not be surprised by a process appearing later.
   */
  async quiesce(): Promise<void> {
    this.#generation++
    const wasCold = this.#state === "cold"
    this.#state = "stopping"

    // A cold load may be in flight, and the child it is spawning is the resource we are
    // here to release. Let it settle first; #doStart will notice the generation moved and
    // close its own child. Without this, tearing down a half-open handshake and letting
    // the start finish behind us is how a stopped daemon ends up still holding VRAM.
    const starting = this.#starting
    if (starting) await starting.catch(() => {})

    const client = this.#client
    this.#client = null
    this.#state = "cold"
    if (wasCold && !client) return
    try {
      await client?.close()
      log.info("stopped")
    } catch (err) {
      // A child that ignores SIGTERM should not block shutdown.
      log.warn("close failed, continuing", { error: describeError(err) })
    }
  }

  async call(ctx: CallContext): Promise<unknown> {
    const method = ctx.method as ForwardedMethod
    const schema = RESULT_SCHEMAS[method]
    if (!schema) {
      throw new BackendError(
        this.name,
        `method not supported over the stdio bridge: ${ctx.method} ` +
          `(supported: ${Object.keys(RESULT_SCHEMAS).join(", ")})`,
      )
    }
    await this.start()
    const client = this.#client
    if (!client) throw new BackendError(this.name, "backend is not connected")

    this.#inflight++
    this.#lastActivityAt = this.#now()
    try {
      return await record(this.#usage, () => client.request(
        { method, params: ctx.params ?? {} } as never,
        schema as never,
        // Both halves of the deadline. The signal is what actually cancels; the timeout
        // is what stops the SDK applying its own 60s default, which is shorter than the
        // 120s onesystem is configured for.
        { signal: ctx.signal, timeout: ctx.timeoutMs },
      ), () => this.#now(), ctx.params)
    } catch (err) {
      if (ctx.signal?.aborted) {
        throw new BackendError(this.name, `${ctx.method} was cancelled: ${describeError(err)}`, err)
      }
      throw new BackendError(this.name, `${ctx.method} failed: ${describeError(err)}`, err)
    } finally {
      // The `finally` is what makes an aborted call releasable. Without it, a cancelled
      // call leaves `inflight` above zero and the idle sweep skips this backend forever.
      this.#inflight--
      this.#lastActivityAt = this.#now()
    }
  }

  describe(): BackendStatus & { command: string; generation: number } {
    return {
      name: this.name,
      transport: this.transport,
      state: this.#state,
      local: true,
      inflight: this.#inflight,
      idleMs: this.#now() - this.#lastActivityAt,
      ...this.#usage,
      command: this.spec.command.join(" "),
      generation: this.#generation,
    }
  }
}

/**
 * Bound the handshake, and say so plainly.
 *
 * Local, because a start has no caller-supplied signal to ride: the abort would have to
 * be threaded through `start()`, and the only thing that wants to cancel a start is a
 * quiesce — which is already handled by the generation counter, not by a timer.
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
