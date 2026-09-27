/**
 * A backend that is not a backend.
 *
 * Two reasons this exists rather than mocking at the call sites:
 *
 *   1. The `Backend` interface is a real seam — two adapters sit behind it — so it is the
 *      test surface. A fake that implements it is the correct way to exercise anything
 *      that is not a backend, and it needs no child process and no GPU.
 *   2. The lifecycle rules in the stdio adapter (the stop/start race, cancellation, the
 *      idle window) are about timing. Reproducing them against a real spawned process
 *      means sleeping for tens of seconds and hoping; against a fake whose `start` is a
 *      promise the test controls, they are exact.
 *
 * `DeferredBackend` is the interesting one: it lets a test hold a start open, quiesce in
 * the middle of it, and assert what the world looks like afterwards. That is the exact
 * race that used to leave a live process holding VRAM after the daemon believed it had
 * stopped.
 */

import type { Backend, BackendState, BackendStatus, CallContext } from "../../src/backend/types.ts"
import { BackendError } from "../../src/backend/types.ts"

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
    try {
      if (ctx.method === "tools/list") return { tools: this.#tools }
      if (this.#fail) throw this.#fail
      return this.#result
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
    }
  }
}

/**
 * A backend whose `start` can be held open, so a test can interleave.
 *
 * `handshake` is the gate: `call` awaits it before going warm, which is exactly the
 * 20-54s window a real cold load opens during which a shutdown can arrive.
 */
export class DeferredBackend implements Backend {
  readonly name = "deferred"
  readonly transport = "stdio-mcp" as const
  readonly local = true
  toolPrefix: string | undefined

  #state: BackendState = "cold"
  #release!: () => void
  #entered!: () => void
  #enteredPromise: Promise<void>
  /** Resolves once a call has reached the gate. */
  readonly entered: Promise<void>
  /** Set if a call started after quiesce returned — the bug, if it happens. */
  startedAfterQuiesce = false
  quiesceReturned = false
  publishedAfterQuiesce = false

  constructor() {
    this.#enteredPromise = new Promise<void>((r) => {
      this.#entered = r
    })
    this.entered = this.#enteredPromise
  }

  /** Let the held start proceed. */
  release(): void {
    this.#release()
  }

  get state(): BackendState {
    return this.#state
  }

  async call(ctx: CallContext): Promise<unknown> {
    if (this.quiesceReturned) this.startedAfterQuiesce = true
    this.#state = "starting"
    this.#entered()
    await new Promise<void>((r) => {
      this.#release = r
    })
    if (this.quiesceReturned) this.publishedAfterQuiesce = true
    this.#state = "warm"
    return { content: [{ type: "text", text: "ok" }] }
  }

  async quiesce(): Promise<void> {
    this.quiesceReturned = true
    this.#state = "cold"
  }

  describe(): BackendStatus {
    return {
      name: this.name,
      transport: this.transport,
      state: this.#state,
      inflight: 0,
      idleMs: 0,
      local: true,
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
    }
  }
}

export { BackendError }
