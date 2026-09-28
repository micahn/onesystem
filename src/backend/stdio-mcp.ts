/**
 * Start a local MCP process, complete its handshake, and forward requests.
 * Laya can spend about 30 seconds importing transformers before binding stdio;
 * startupTimeoutSecs allows for this. The supervisor owns idle and request policy.
 * Quiesce advances a generation counter and waits for any pending start. A stale
 * start closes its child instead of publishing it after shutdown.
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
import { CallLedger } from "./usage.ts"
import { logger } from "../log.ts"
import { BackendError, type Backend, type BackendState, type BackendStatus, type CallContext } from "./types.ts"

const log = logger("stdio-mcp")

/**
 * SDK result schema for each supported MCP method. Client.request calls safeParse,
 * so it needs a schema, not a pass-through function. Reject unmapped methods.
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
  /**
   * Shared call accounting. Leaked inflight counts would prevent idle shutdown.
   */
  #ledger: CallLedger
  /**
   * Bumped by every quiesce. A start that began under an older generation is stale, and
   * must tear its own child down rather than publish it.
   */
  #generation = 0

  constructor(
    readonly name: string,
    private readonly spec: StdioBackend,
    private readonly deps: { now?: () => number } = {},
  ) {
    // Keep the clock method bound to this backend.
    this.#ledger = new CallLedger(() => this.#now())
  }

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
   * Read tool names from config without starting the child.
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
    this.#ledger.touch()
    const generation = this.#generation
    this.#starting = this.#doStart(generation).finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async #doStart(generation: number): Promise<void> {
    // Fallback for hand-built specs; validate normally supplies this value.
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

    // Quiesce invalidated this start while the handshake was pending.
    if (generation !== this.#generation) {
      this.#state = "cold"
      await client.close().catch(() => {})
      log.info("discarded a start that was quiesced mid-handshake", { name: this.name })
      return
    }

    this.#client = client
    this.#state = "warm"
    this.#ledger.touch()
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

    // Wait for #doStart to detect the new generation and close its child.
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
    // Validation above, accounting below. A method this transport cannot serve never
    // reaches the model, so it is not a call and gets no duration and no error count.
    try {
      return await this.#ledger.track(async () => {
        // Include cold startup in inflight and end-to-end timing.
        await this.start()
        const client = this.#client
        if (!client) throw new BackendError(this.name, "backend is not connected")
        return client.request(
          { method, params: ctx.params ?? {} } as never,
          schema as never,
          // Both halves of the deadline. The signal is what actually cancels; the timeout
          // is what stops the SDK applying its own 60s default, which is shorter than the
          // 120s onesystem is configured for.
          { signal: ctx.signal, timeout: ctx.timeoutMs },
        )
      }, ctx.params)
    } catch (err) {
      if (ctx.signal?.aborted) {
        throw new BackendError(this.name, `${ctx.method} was cancelled: ${describeError(err)}`, err)
      }
      throw new BackendError(this.name, `${ctx.method} failed: ${describeError(err)}`, err)
    }
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
 * Bound the handshake wait. The caller closes the client on timeout;
 * quiesce invalidates pending starts through the generation counter.
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
