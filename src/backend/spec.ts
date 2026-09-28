/**
 * Backend config types. Keep this module dependency-free to avoid config/type cycles.
 * Runtime interfaces and status types live in backend/types.ts.
 */

export type Transport = "stdio-mcp" | "systemone-http"

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

export type BackendSpec = StdioBackend | SystemOneBackend

/** A declared backend, plus whether the person writing the file turned it on. */
export type ConfiguredBackend = BackendSpec & { enabled?: boolean }
