/**
 * Backend contract.
 *
 * A backend is a System 1 decision service. The supervisor knows nothing about how one
 * is reached, only that it can be started, stopped, and asked to forward MCP traffic.
 *
 * The central property of this interface is that `start()` is lazy and expensive while
 * everything else is cheap. Loading a model costs 20-54s and up to 3 GB of VRAM, so it
 * must never happen on a path the user did not ask for. Nothing in onesystem calls
 * `start()` except forwarded MCP traffic.
 */

export type BackendState = "cold" | "starting" | "warm" | "stopping" | "failed"

export interface ForwardContext {
  method: string
  params?: Record<string, unknown>
  signal?: AbortSignal
}

export interface Backend {
  readonly name: string
  readonly transport: "stdio-mcp" | "systemone-http"
  readonly state: BackendState
  /** Wall-clock ms of the last completed or started forward. Drives idle shutdown. */
  lastActivityAt: number
  /** In-flight forwards. The daemon never idles out from under one. */
  inflight: number
  /** Idempotent. Concurrent callers share one start. */
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * Forward one MCP method to the backend and return its JSON-RPC result.
   * Rejects on a backend error; never returns a partial success.
   */
  forward(ctx: ForwardContext): Promise<unknown>
  /** One-line status for `onesystem status`. Must not load anything. */
  describe(): Record<string, unknown>
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
