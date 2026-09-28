/**
 * Backend lifecycle and supervisor interfaces. Only call may load a model;
 * status and tool declarations must remain cheap. Adapters must honor cancellation
 * and release in-flight accounting so the idle sweep can stop unused models.
 */

import type { Transport } from "./spec.ts"

export type BackendState = "cold" | "starting" | "warm" | "stopping" | "failed"

export interface CallContext {
  method: string
  params?: Record<string, unknown>
  /**
   * Aborted when the call should stop. Implementations must pass this to whatever is
   * actually doing the work, so that an aborted call stops holding local resources.
   */
  signal?: AbortSignal
  /**
   * Request budget in milliseconds. Pass to libraries alongside signal so their
   * own defaults, such as the MCP SDK's 60 seconds, do not shorten the budget.
   */
  timeoutMs?: number
}

/**
 * Read-only status. The idle sweep uses local, inflight, and idleMs to decide what to stop.
 */
export interface BackendStatus {
  name: string
  transport: Transport
  state: BackendState
  /** Forwards currently outstanding. The daemon never idles out from under one. */
  inflight: number
  /** Milliseconds since the last forward started or finished. */
  idleMs: number
  /**
   * True when quiesce releases local resources owned by onesystem.
   */
  local: boolean
  /**
   * Completed calls since daemon start, including failures. Models do not report
   * token counts; usage tracks calls, time, bytes, and answers instead.
   */
  calls: number
  /** Calls that ended in a `BackendError`. */
  errors: number
  /** Wall-clock of the last completed call, or null if there has not been one. */
  lastMs: number | null
  /** Mean wall-clock over every completed call. Null until the first one. */
  meanMs: number | null
  /** Request bytes sent to the model, cumulatively. */
  inBytes: number
  /** Result bytes returned by the model, cumulatively. */
  outBytes: number
  /** Questions answered, cumulatively. Zero for a model whose answers are not countable. */
  answered: number
  /** Answered questions by type, e.g. `{ choice: 12, noul: 3 }`. */
  byType: Record<string, number>
}

export interface Backend {
  readonly name: string
  readonly transport: Transport
  readonly state: BackendState
  /**
   * Product prefix stripped from this backend's tool names by the HTTP front, if any.
   * The bridge needs it in both directions, so it lives on the backend rather than
   * being re-read from config at the edge.
   */
  readonly toolPrefix?: string
  /**
   * Tool names without the product prefix. `/catalog` reads these without loading
   * a model. Use config declarations or a list generated locally by the adapter.
   */
  readonly tools: readonly string[]
  /**
   * Forward one MCP method to the backend and return its JSON-RPC result.
   * Rejects on a backend error; never returns a partial success.
   *
   * The only call that may cause a model to load.
   */
  call(ctx: CallContext): Promise<unknown>
  /**
   * Release resources and settle any start in progress before returning.
   * Must be idempotent; no child may appear after cleanup completes.
   */
  quiesce(): Promise<void>
  /**
   * Pids of the processes this backend owns, for attributing GPU memory to it. Empty when it
   * owns nothing, and empty while cold: a pid that has gone is better reported as absent
   * than carried in a stale map.
   */
  ownedPids(): number[]
  /** Status for `onesystem status` and `GET /health`. Must not load anything. */
  describe(): BackendStatus
}

/**
 * Supervisor interface used by the daemon and HTTP layer; tests can supply a fake.
 */
export interface BackendPort {
  /** Every enabled backend's name, in config order. */
  names(): string[]
  /** The backend at `name`. Throws `BackendError` listing the configured names. */
  get(name: string): Backend
  /**
   * Forward one MCP request. The only path in the daemon that may cause a model to load,
   * and where the request timeout is applied and enforced.
   */
  call(name: string, method: string, params: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown>
  /** Status for every backend. Loads nothing. */
  snapshot(): { backends: BackendStatus[] }
  /** True while at least one locally-owned backend holds a process. */
  anyLocalWarm(): boolean
  /**
   * Begin watching for the quiet window. `onIdle` fires at most once, when the last
   * locally-owned backend has been warm and then gone silent.
   */
  watchIdle(onIdle: () => void): void
  /** Stop every locally-owned backend. Used on daemon shutdown. */
  quiesce(): Promise<void>
}

export class BackendError extends Error {
  constructor(
    readonly backend: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = "BackendError"
  }
}
