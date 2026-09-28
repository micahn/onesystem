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
 * running, replace `call()` with a typed adapter and the tool surface gets proper
 * schemas. The transport, lifecycle, and HTTP fronting stay exactly as they are.
 */

import type { SystemOneBackend } from "../config.ts"
import { describeError, startDeadline } from "../async.ts"
import { emptyUsage, record } from "./usage.ts"
import { logger } from "../log.ts"
import { BackendError, type Backend, type BackendState, type BackendStatus, type CallContext } from "./types.ts"

const log = logger("systemone-http")

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export class SystemOneBackendImpl implements Backend {
  readonly transport = "systemone-http" as const
  /**
   * Nothing local to release, so the idle sweep must not count this backend. Stated here
   * rather than inferred from the transport at four call sites: "is this ours to stop" is
   * a fact about the adapter, not a pattern match the supervisor repeats.
   */
  readonly local = false

  /** A remote service is always "warm": there is nothing local to start or hold. */
  #state: BackendState = "warm"
  #reachable: boolean | null = null
  #lastActivityAt = Date.now()
  #inflight = 0
  #usage = emptyUsage()

  constructor(
    readonly name: string,
    private readonly spec: SystemOneBackend,
    private readonly deps: { fetch?: FetchLike; now?: () => number } = {},
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
   * Read off the same list the adapter answers `tools/list` with.
   *
   * This transport needs no declared list in config, because it has no child process to
   * start: the surface is a constant right here. Deriving from `systemoneToolList` rather
   * than repeating the name keeps the two from drifting, which is the one thing a tool
   * surface must not do — a catalog advertising a name `call` will refuse.
   */
  get tools(): readonly string[] {
    const list = systemoneToolList() as { tools?: { name?: unknown }[] }
    return (list.tools ?? [])
      .map((t) => t.name)
      .filter((name): name is string => typeof name === "string")
  }

  /** No-op, and not merely because it is cheap: there is no process to own. */
  async start(): Promise<void> {
    this.#lastActivityAt = this.#now()
  }

  async quiesce(): Promise<void> {
    // Nothing local to release. The supervisor still counts this backend as warm, so it
    // is exempt from the idle sweep; see BackendStatus#local.
  }

  call(ctx: CallContext): Promise<unknown> {
    // Wrapped rather than awaited, so one place times the whole call including the
    // unsupported-method and unknown-tool rejections above, which are errors the user sees.
    return record(this.#usage, () => this.#doCall(ctx), () => this.#now(), ctx.params)
  }

  async #doCall(ctx: CallContext): Promise<unknown> {
    this.#inflight++
    this.#lastActivityAt = this.#now()
    try {
      // Answered here, not in the supervisor. The tool surface is this adapter's own
      // business, and special-casing it one layer up meant the request path had a branch
      // that only applied to one transport — a third transport would need a fourth edit
      // in a module that has no reason to know any of them.
      if (ctx.method === "tools/list") {
        return systemoneToolList()
      }
      if (ctx.method !== "tools/call") {
        throw new BackendError(this.name, `method not supported by the systemone adapter: ${ctx.method}`)
      }
      const name = (ctx.params as { name?: unknown } | undefined)?.name
      if (name !== "systemone") {
        throw new BackendError(this.name, `unknown tool: ${String(name)}`)
      }
      const body = (ctx.params as { arguments?: unknown }).arguments

      const url = `${this.spec.baseUrl}/v1/systemone`
      const timeoutMs = ctx.timeoutMs ?? (this.spec.startupTimeoutSecs ?? 30) * 1000
      const doFetch = this.deps.fetch ?? ((input, init) => fetch(input, init))
      const body_text = JSON.stringify(body ?? {})

      // The deadline and the caller's signal both have to reach fetch, and they are two
      // separate aborts. The old code took `ctx.signal ?? controller.signal`, which meant
      // that supplying a caller signal silently discarded the timeout — a branch that
      // read as a merge and behaved as a replacement.
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
        // MCP tool results are content blocks, so wrap the untouched body. The body
        // itself is passed through verbatim in both directions.
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
    } catch (err) {
      this.#reachable = false
      if (err instanceof BackendError) throw err
      throw new BackendError(this.name, `forward failed: ${describeError(err)}`, err)
    } finally {
      this.#inflight--
      this.#lastActivityAt = this.#now()
    }
  }

  describe(): BackendStatus & { baseUrl: string; reachable: boolean | null } {
    return {
      name: this.name,
      transport: this.transport,
      state: this.#state,
      local: false,
      inflight: this.#inflight,
      idleMs: this.#now() - this.#lastActivityAt,
      ...this.#usage,
      baseUrl: this.spec.baseUrl,
      reachable: this.#reachable,
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
