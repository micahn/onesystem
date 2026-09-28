/**
 * Backend contract, and the port the rest of the daemon depends on.
 *
 * A backend is a System 1 decision service. The supervisor knows nothing about how one
 * is reached, only that it can forward MCP traffic to it, stop it, and describe it.
 *
 * The central property of this interface is that a forward is lazy and expensive while
 * everything else is cheap. Loading a model costs 20-54s and up to 3 GB of VRAM, so it
 * must never happen on a path the user did not ask for. Nothing in onesystem calls a
 * forward except a request an agent actually made.
 *
 * ## What is not in the interface, and why
 *
 * `lastActivityAt` and `inflight` used to be public mutable fields here, because the idle
 * sweep needed them. That put the accounting mechanism on the seam: any caller could write
 * them, and a test had to fake a clock and mutate state to exercise a policy decision.
 * They are private now, and the sweep reads them through `describe()` — which already
 * existed to answer "what is this backend doing" without loading anything, and is exactly
 * the question the sweep was asking. One read-only view, used by the one consumer.
 *
 * Likewise `forward` is now `call`, and it takes a signal that the implementation must
 * honour. The old signature accepted a signal that no caller ever set and no adapter ever
 * read, which made a request timeout abandon the work it claimed to bound: `inflight`
 * stayed above zero and the idle sweep skipped that backend forever. A cancellation path
 * that is optional in the interface is a cancellation path that does not happen.
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
   * Ceiling for this call, in milliseconds.
   *
   * The supervisor owns the deadline and expresses it twice on purpose. `signal` is the
   * authority — it is the only form every adapter can honour — and `timeoutMs` lets an
   * adapter hand the same budget to a library that wants a number instead. Without the
   * number, the MCP SDK applies its own 60s default, which is *shorter* than the 120s
   * onesystem is configured for, so a legitimately slow call would fail against a
   * timeout the user never chose.
   */
  timeoutMs?: number
}

/**
 * One backend's status, read without loading anything.
 *
 * This is the whole of what the outside world may know about a backend's internals. The
 * idle sweep is a consumer: it reads `inflight` and `idleMs` to decide whether a backend
 * has gone quiet, and `local` to decide whether stopping it would release anything.
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
   * True when quiescing this backend releases local resources that onesystem owns.
   *
   * Declared here rather than inferred from `transport` at four call sites, so that a
   * transport can be added without also updating every predicate that switches on it.
   */
  local: boolean
  /**
   * Usage, since the daemon started.
   *
   * Deliberately not token counts. Neither model reports them — laya answers with
   * `answers`, `routing`, `latency_ms` and `device`, julia with `answers` alone — and a
   * locally-run model bills nothing, so a number here would be a guess wearing a
   * counter's clothes. What is worth knowing is how often the model is being used and how
   * long it takes, because that is what says whether the idle window is doing its job.
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
   * The tool names this backend exposes, without the product prefix. Must not load.
   *
   * Declared rather than discovered, because discovering it means starting the process,
   * and starting the process is the one thing this project refuses to do on a path the
   * agent did not ask for. `GET /catalog` reads this to hand the opencode plugin a tool
   * surface at session start, which is the only reason it exists.
   *
   * A backend that answers `tools/list` from somewhere other than a child process —
   * `systemone-http` synthesises its own list — reads it from there instead, so the
   * contract is "the surface", not "the config".
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
   * Release everything this backend holds, and wait until it is released.
   *
   * Idempotent, and — the part that is easy to get wrong — it must also settle any
   * start that is in flight. A quiesce that returns while a cold load is still
   * connecting hands the caller a daemon that believes it is stopped while a process
   * is still coming up. Implementations are responsible for that, because only they
   * know what they are waiting on.
   */
  quiesce(): Promise<void>
  /** Status for `onesystem status` and `GET /health`. Must not load anything. */
  describe(): BackendStatus
}

/**
 * What the daemon depends on, rather than on how any backend works.
 *
 * Two adapters sit behind this (a local process, and somebody else's server), so the seam
 * is real by the two-adapter rule, and it is also the test surface: everything in the
 * daemon that is not a backend can be tested by handing it a port that is not one.
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
