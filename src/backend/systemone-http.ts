/**
 * Forward a systemone tool to an existing POST /v1/systemone service.
 * The service owns its lifecycle. Bodies pass through because the exact schema
 * has not been verified against a live service; add types after verifying it.
 */

import type { SystemOneBackend } from "../config.ts"
import { describeError, startDeadline } from "../async.ts"
import { CallLedger } from "./usage.ts"
import { logger } from "../log.ts"
import { BackendError, type Backend, type BackendState, type BackendStatus, type CallContext } from "./types.ts"

const log = logger("systemone-http")

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export class SystemOneBackendImpl implements Backend {
  readonly transport = "systemone-http" as const
  /**
   * No owned process; exclude this backend from local idle shutdown.
   */
  readonly local = false

  /** A remote service is always "warm": there is nothing local to start or hold. */
  #state: BackendState = "warm"
  #reachable: boolean | null = null
  /**
   * Use the same call accounting as the local adapter.
   */
  #ledger: CallLedger

  constructor(
    readonly name: string,
    private readonly spec: SystemOneBackend,
    private readonly deps: { fetch?: FetchLike; now?: () => number } = {},
  ) {
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
   * Share tools/list's local declaration; no config list or network request is needed.
   */
  get tools(): readonly string[] {
    const list = systemoneToolList() as { tools?: { name?: unknown }[] }
    return (list.tools ?? [])
      .map((t) => t.name)
      .filter((name): name is string => typeof name === "string")
  }

  /** Mark activity without starting a process. */
  async start(): Promise<void> {
    this.#ledger.touch()
  }

  async quiesce(): Promise<void> {
    // The external service owns its lifecycle; there is nothing local to release.
  }

  async call(ctx: CallContext): Promise<unknown> {
    // Local catalog reads and rejected methods do not count as model calls.
    if (ctx.method === "tools/list") return systemoneToolList()
    if (ctx.method !== "tools/call") {
      throw new BackendError(this.name, `method not supported by the systemone adapter: ${ctx.method}`)
    }
    const name = (ctx.params as { name?: unknown } | undefined)?.name
    if (name !== "systemone") {
      throw new BackendError(this.name, `unknown tool: ${String(name)}`)
    }
    const body = (ctx.params as { arguments?: unknown }).arguments

    try {
      return await this.#ledger.track(() => this.#forward(ctx, body), ctx.params)
    } catch (err) {
      this.#reachable = false
      if (err instanceof BackendError) throw err
      throw new BackendError(this.name, `forward failed: ${describeError(err)}`, err)
    }
  }

  async #forward(ctx: CallContext, body: unknown): Promise<unknown> {
    const url = `${this.spec.baseUrl}/v1/systemone`
    // Prefer the caller's budget. The fallback supports specs built without validate.
    const timeoutMs = ctx.timeoutMs ?? (this.spec.startupTimeoutSecs ?? 30) * 1000
    const doFetch = this.deps.fetch ?? ((input, init) => fetch(input, init))
    const body_text = JSON.stringify(body ?? {})

    // Either the deadline or caller cancellation must abort fetch.
    const deadline = startDeadline(timeoutMs)
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline.signal]) : deadline.signal

    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body_text,
        signal,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new BackendError(this.name, `${url} returned ${res.status}: ${text.slice(0, 300)}`)
      }
      this.#reachable = true
      // MCP tool results are content blocks, so wrap the untouched body. The body itself
      // is passed through verbatim in both directions.
      return { content: [{ type: "text", text }] }
    } catch (err) {
      if (deadline.timedOut()) {
        throw new BackendError(this.name, `POST ${url} exceeded ${timeoutMs}ms`, err)
      }
      if (ctx.signal?.aborted) {
        throw new BackendError(this.name, `POST ${url} was cancelled`, err)
      }
      throw err
    } finally {
      deadline.dispose()
    }
  }

  describe(): BackendStatus {
    return {
      name: this.name,
      transport: this.transport,
      state: this.#state,
      local: false,
      inflight: this.#ledger.inflight,
      idleMs: this.#now() - this.#ledger.lastActivityAt,
      ...this.#ledger.usage,
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
          "Send the service's documented request body to POST {baseUrl}/v1/systemone. " +
          "Returns the response unchanged. The schema has not been verified against a live service.",
        inputSchema: { type: "object", additionalProperties: true },
      },
    ],
  }
}
