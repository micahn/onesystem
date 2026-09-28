/**
 * What a backend is, as declared in the config file.
 *
 * This module exists because of where it does *not* import from, and that is the whole
 * reason for it.
 *
 * `Transport` used to be declared in `config.ts`, which meant the runtime's own vocabulary
 * had to be imported from the module that owns file parsing — so `backend/types.ts` imported
 * `config.ts` to say what a transport was, and `config.ts` imported `health.ts` to describe
 * what the daemon reports, and `health.ts` imported `backend/types.ts`. A three-module type
 * cycle:
 *
 *     config.ts -> health.ts -> backend/types.ts -> config.ts
 *
 * It compiled, because every edge was `import type`. But the entanglement was structural
 * rather than accidental: the concept "what a backend is" could not be stated without also
 * dragging in "where the config file lives" and "how it is validated", neither of which has
 * anything to do with a stdio process speaking MCP.
 *
 * So the vocabulary a backend is described in lives here, importing nothing, and the cycle
 * has nowhere to close. `config.ts` imports these types to validate a file; the adapters
 * import them to be constructed; `backend/types.ts` imports `Transport` and nothing else.
 *
 * This is the *declared* shape, from the config. The *runtime* shape — `BackendStatus`,
 * `CallContext`, the adapter interface — is `backend/types.ts`, and the two are different
 * things: this one is what a person wrote, that one is what a running process reports.
 */

export type Transport = "stdio-mcp" | "systemone-http"

/**
 * How a backend presents itself to opencode.
 *
 * Tool names are rewritten on the way through so the surface reads
 * `onesystem.predict` rather than `onesystem.laya_predict`. The prefix is stripped
 * explicitly rather than guessed: the daemon cannot know that a backend's tools happen
 * to be prefixed with its own product name, and a wrong guess would silently rename
 * every tool. An unset prefix means names pass through untouched.
 */
export interface BackendNaming {
  /**
   * Stripped from tool names as they cross the bridge, and added back on the way in.
   * `"laya_"` turns `laya_predict` into `predict`.
   */
  toolPrefix?: string
  /**
   * Name opencode registers this backend's MCP server under. Defaults to `onesystem`
   * when exactly one backend is enabled, and `onesystem-<backend>` otherwise, so two
   * backends cannot claim the same server name.
   *
   * Read by `naming.planNames` and by nothing else. It is the one field here that three
   * modules used to have an opinion about.
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
   * The tool names this backend exposes, without the product prefix.
   *
   * Required, and this is the one place a model surface is written down by hand. It used
   * to be read from the model's own `tools/list` at session start, which is a
   * contradiction this project's central property cannot survive: asking the model *is*
   * the 20-54s load and 3 GB of VRAM that the lazy-start contract exists to keep off a
   * path the agent did not ask for. So the surface is declared here, and the daemon hands
   * it out without loading anything.
   *
   * The trade is real and worth stating plainly. laya went from 0.3.10 to 0.3.21 during
   * development and added a tool, so this list can go stale against a release. When it
   * does, a name here that the process does not answer fails the call with the backend's
   * own "unknown tool" rather than silently doing nothing — which is the failure mode this
   * list exists to prefer over a session that loads three gigabytes of torch before the
   * agent has typed anything.
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
