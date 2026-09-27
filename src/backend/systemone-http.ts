/**
 * `POST /v1/systemone` backend.
 *
 * The second transport, and the reason the config has a `backends` map instead of a
 * single hardcoded laya command. `rev` publishes this spec, and so does TypeSafe's
 * `typesafe-sdk`, so anything implementing it is a drop-in peer of laya even though it
 * is a completely different process model: laya needs onesystem to own a local
 * process, `rev` is already a server someone else started.
 *
 * onesystem therefore does not start these. It only calls them, and a failure to reach
 * one is reported as a failed forward rather than a failed start.
 *
 * ## What is deliberately not here
 *
 * A typed `predict` tool mirroring laya's `state` + `questions` shape. It would be
 * guesswork: the exact `/v1/systemone` request and response schema is not verified
 * against a live service here, and inventing field names that silently do nothing is
 * worse than an honest pass-through. So this exposes one `systemone` tool that takes
 * the request body verbatim and returns the response verbatim. Once a real service is
 * running, replace `forward()` with a typed adapter and the tool surface gets proper
 * schemas. The transport, lifecycle, and HTTP fronting stay exactly as they are.
 */

import type { SystemOneBackend } from "../config.ts"
import { logger } from "../log.ts"
import { BackendError, type Backend, type BackendState, type ForwardContext } from "./types.ts"
import { describe } from "./stdio-mcp.ts"

const log = logger("systemone-http")

export class SystemOneBackendImpl implements Backend {
  readonly transport = "systemone-http" as const
  lastActivityAt = Date.now()
  inflight = 0

  /** A remote service is always "warm": there is nothing local to start or hold. */
  #state: BackendState = "warm"
  #reachable: boolean | null = null

  constructor(
    readonly name: string,
    private readonly spec: SystemOneBackend,
  ) {}

  get state(): BackendState {
    return this.#state
  }

  /** No-op, and not merely because it is cheap: there is no process to own. */
  async start(): Promise<void> {
    this.lastActivityAt = Date.now()
  }

  async stop(): Promise<void> {
    // Nothing local to release. The supervisor still counts this backend as warm, so it
    // is exempt from the idle sweep; see Supervisor#sweep.
  }

  async forward(ctx: ForwardContext): Promise<unknown> {
    this.inflight++
    this.lastActivityAt = Date.now()
    try {
      if (ctx.method !== "tools/call") {
        throw new BackendError(this.name, `method not supported by the systemone adapter: ${ctx.method}`)
      }
      const name = (ctx.params as { name?: unknown } | undefined)?.name
      if (name !== "systemone") {
        throw new BackendError(this.name, `unknown tool: ${String(name)}`)
      }
      const body = (ctx.params as { arguments?: unknown }).arguments

      const url = `${this.spec.baseUrl}/v1/systemone`
      const timeoutMs = (this.spec.startupTimeoutSecs ?? 30) * 1000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: ctx.signal ?? controller.signal,
        })
        const text = await res.text()
        if (!res.ok) {
          throw new BackendError(this.name, `${url} returned ${res.status}: ${text.slice(0, 300)}`)
        }
        this.#reachable = true
        // MCP tool results are content blocks, so wrap the untouched body. The body
        // itself is passed through verbatim in both directions.
        return { content: [{ type: "text", text }] }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      this.#reachable = false
      if (err instanceof BackendError) throw err
      throw new BackendError(this.name, `forward failed: ${describe(err)}`, err)
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
      baseUrl: this.spec.baseUrl,
      reachable: this.#reachable,
      inflight: this.inflight,
    }
  }
}

/** The single tool this adapter exposes, as an MCP `tools/list` result. */
export function systemoneToolList(): unknown {
  return {
    tools: [
      {
        name: "systemone",
        description:
          "Verbatim pass-through to POST {baseUrl}/v1/systemone. Send the request body this " +
          "service documents; the response is returned unchanged. No schema is imposed here " +
          "on purpose, because the /v1/systemone schema is not yet verified against a live " +
          "service.",
        inputSchema: { type: "object", additionalProperties: true },
      },
    ],
  }
}
