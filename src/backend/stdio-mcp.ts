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
import { logger } from "../log.ts"
import { BackendError, type Backend, type BackendState, type ForwardContext } from "./types.ts"

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
  lastActivityAt = Date.now()
  inflight = 0

  #state: BackendState = "cold"
  #client: Client | null = null
  #starting: Promise<void> | null = null

  constructor(
    readonly name: string,
    private readonly spec: StdioBackend,
  ) {}

  get state(): BackendState {
    return this.#state
  }

  get toolPrefix(): string | undefined {
    return this.spec.toolPrefix
  }

  async start(): Promise<void> {
    if (this.#state === "warm") return
    if (this.#starting) return this.#starting

    this.#state = "starting"
    this.lastActivityAt = Date.now()
    this.#starting = this.#doStart().finally(() => {
      this.#starting = null
    })
    return this.#starting
  }

  async #doStart(): Promise<void> {
    const timeoutMs = (this.spec.startupTimeoutSecs ?? 180) * 1000
    const started = Date.now()
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
      await withTimeout(client.connect(transport), timeoutMs, `connect ${this.name}`)
    } catch (err) {
      // Tear the half-open child down; leaving it would strand VRAM and the port.
      await client.close().catch(() => {})
      this.#state = "failed"
      throw new BackendError(
        this.name,
        `failed to start within ${timeoutMs / 1000}s: ${describe(err)}`,
        err,
      )
    }

    this.#client = client
    this.#state = "warm"
    this.lastActivityAt = Date.now()
    log.info("warm", { startupMs: Date.now() - started })
  }

  async stop(): Promise<void> {
    if (this.#state === "cold") return
    this.#state = "stopping"
    const client = this.#client
    this.#client = null
    try {
      await client?.close()
    } catch (err) {
      // A child that ignores SIGTERM should not block shutdown.
      log.warn("close failed, continuing", { error: describe(err) })
    }
    this.#state = "cold"
    log.info("stopped")
  }

  async forward(ctx: ForwardContext): Promise<unknown> {
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

    this.inflight++
    this.lastActivityAt = Date.now()
    try {
      return await client.request({ method, params: ctx.params ?? {} } as never, schema as never)
    } catch (err) {
      throw new BackendError(this.name, `${ctx.method} failed: ${describe(err)}`, err)
    } finally {
      this.inflight--
      this.lastActivityAt = Date.now()
    }
  }

  describe(): Record<string, unknown> {
    return {
      name: this.name,
      transport: this.transport,
      state: this.#state,
      command: this.spec.command.join(" "),
      inflight: this.inflight,
      idleMs: Date.now() - this.lastActivityAt,
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
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

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
