/**
 * A backend that is not a backend.
 *
 * Two reasons this exists rather than mocking at the call sites:
 *
 *   1. The `Backend` interface is a real seam — two adapters sit behind it — so it is the
 *      test surface. A fake that implements it is the correct way to exercise anything
 *      that is not a backend, and it needs no child process and no GPU.
 *   2. Cancellation and the idle window are policy, not process management, so a fake is
 *      the honest way to test them: no sleeps, no child, no clock drift.
 *
 * The stop/start race is *not* here. That one is about whether a real spawned process is
 * actually reaped, so it is tested against a real one in `lifecycle.test.ts` with
 * `slow-mcp.ts` — a fake could only assert that it was told to quiesce.
 */

import type { Backend, BackendState, BackendStatus, CallContext } from "../../src/backend/types.ts"
import { BackendError } from "../../src/backend/types.ts"
import { emptyUsage, finish } from "../../src/backend/usage.ts"

export interface FakeBackendOptions {
  name?: string
  transport?: "stdio-mcp" | "systemone-http"
  toolPrefix?: string
  local?: boolean
  /** Answers `tools/list`. */
  tools?: { name: string }[]
  /** Throw this instead of answering. */
  fail?: Error
  /** Resolves with this. Defaults to `{ content: [{ type: "text", text: "ok" }] }`. */
  result?: unknown
}

export class FakeBackend implements Backend {
  readonly name: string
  readonly transport: "stdio-mcp" | "systemone-http"
  readonly toolPrefix?: string
  readonly local: boolean

  /** Everything `call` was asked, in order. */
  readonly calls: CallContext[] = []
  /** How many times quiesce was called. */
  quiesceCount = 0
  /** True between a call starting and finishing. */
  busy = false
  #usage = emptyUsage()
  #state: BackendState = "cold"
  #idleMs = 0
  #result: unknown
  #tools: { name: string }[]
  #fail: Error | undefined

  constructor(private readonly options: FakeBackendOptions = {}) {
    this.name = options.name ?? "fake"
    this.transport = options.transport ?? "stdio-mcp"
    this.toolPrefix = options.toolPrefix
    this.local = options.local ?? this.transport === "stdio-mcp"
    this.#result = options.result ?? { content: [{ type: "text", text: "ok" }] }
    this.#tools = options.tools ?? []
    this.#fail = options.fail
  }

  get state(): BackendState {
    return this.#state
  }

  /** Put the backend in a state without going through a call. For sweep tests. */
  setState(state: BackendState, idleMs = 0): void {
    this.#state = state
    this.#idleMs = idleMs
  }

  async call(ctx: CallContext): Promise<unknown> {
    this.calls.push(ctx)
    this.busy = true
    this.#state = "warm"
    this.#idleMs = 0
    const started = Date.now()
    try {
      if (ctx.method === "tools/list") {
        finish(this.#usage, Date.now() - started, false)
        return { tools: this.#tools }
      }
      if (this.#fail) throw this.#fail
      finish(this.#usage, Date.now() - started, false)
      return this.#result
    } catch (err) {
      finish(this.#usage, Date.now() - started, true)
      throw err
    } finally {
      this.busy = false
      this.#idleMs = 0
    }
  }

  async quiesce(): Promise<void> {
    this.quiesceCount++
    this.#state = "cold"
  }

  describe(): BackendStatus {
    return {
      name: this.name,
      transport: this.transport,
      state: this.#state,
      inflight: this.busy ? 1 : 0,
      idleMs: this.#idleMs,
      local: this.local,
      ...this.#usage,
    }
  }
}

/** A backend that never settles, for testing that a deadline actually fires. */
export class HangingBackend implements Backend {
  readonly name = "hanging"
  readonly transport = "stdio-mcp" as const
  readonly local = true
  #state: BackendState = "cold"
  inflightSeen = 0

  get state(): BackendState {
    return this.#state
  }

  async call(ctx: CallContext): Promise<unknown> {
    this.#state = "warm"
    // Respects the signal if it is ever passed one; does not settle on its own.
    if (ctx.signal) {
      await new Promise<never>((_, reject) => {
        ctx.signal!.addEventListener("abort", () => reject(new Error("aborted")))
      })
    }
    await new Promise(() => {})
    return undefined
  }

  async quiesce(): Promise<void> {
    this.#state = "cold"
  }

  describe(): BackendStatus {
    return {
      name: this.name,
      transport: this.transport,
      state: this.#state,
      inflight: this.#state === "warm" ? ++this.inflightSeen : 0,
      idleMs: 0,
      local: true,
      calls: 0,
      errors: 0,
      lastMs: null,
      meanMs: null,
    }
  }
}

export { BackendError }
