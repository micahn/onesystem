/**
 * Backend config types. Keep this module dependency-free to avoid config/type cycles.
 * Runtime interfaces and status types live in backend/types.ts.
 */

export type Transport = "stdio-mcp" | "systemone-http" | "systemone-serve"

/**
 * Display names. Strip only the declared tool prefix; leave names unchanged when unset.
 */
export interface BackendNaming {
  /**
   * Stripped from tool names as they cross the bridge, and added back on the way in.
   * `"laya_"` turns `laya_predict` into `predict`.
   */
  toolPrefix?: string
  /**
   * Server name in status reports. Defaults to `onesystem` for one enabled backend,
   * or `onesystem-<backend>` for several. Resolved by naming.planNames.
   */
  serverName?: string
}

export interface StdioBackend extends BackendNaming {
  transport: "stdio-mcp"
  /** Executable plus args. First element is the program. */
  command: string[]
  env?: Record<string, string>
  cwd?: string
  /** Handshake budget for spawning this process and completing `initialize`. */
  startupTimeoutSecs?: number
  /**
   * Required tool names without the product prefix. A declared list lets `/catalog`
   * answer without starting the process. Update it when the model's tools change;
   * stale names fail with the backend's "unknown tool" error at call time.
   */
  tools: string[]
}

export interface SystemOneBackend extends BackendNaming {
  transport: "systemone-http"
  /** Base URL of a running service, without the /v1/systemone path. */
  baseUrl: string
  startupTimeoutSecs?: number
}

/**
 * A `/v1/systemone` service that onesystem launches, rather than one already running.
 *
 * `cwd` is part of the contract and not a convenience: these servers resolve their weights
 * and their own runtime relative to where they were started, so a spawn without it finds
 * nothing. `model` is required because the service selects by name and has no default.
 */
export interface ServeBackend extends BackendNaming {
  transport: "systemone-serve"
  command: string[]
  cwd?: string
  env?: Record<string, string>
  /** Base URL the service binds, without any path. */
  baseUrl: string
  /** Polled until `{"status":"ready"}`. A 200 alone means the port is up, not the model. */
  healthPath?: string
  systemonePath?: string
  /** Model name the service is asked for. It has no default and will not guess one. */
  model: string
  startupTimeoutSecs?: number
  /**
   * Required, so `/catalog` answers without loading weights. Stale names fail at call
   * time with the service's own "unknown tool".
   */
  tools: string[]
}

export type BackendSpec = StdioBackend | SystemOneBackend | ServeBackend

/** A declared backend, plus whether the person writing the file turned it on. */
export type ConfiguredBackend = BackendSpec & { enabled?: boolean }
