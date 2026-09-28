/**
 * Configuration: what backends exist, where they listen, and when they shut down.
 *
 * Two backend transports, because the System 1 landscape of Sept 2026 does not agree
 * on one:
 *
 *   - `stdio-mcp` — a local process speaking MCP over stdin/stdout. This is what
 *     `laya` is, and it is the transport that needs a real local process.
 *   - `systemone-http` — an already-running service speaking `POST /v1/systemone`,
 *     the spec published by TypeSafe's typesafe-sdk and implemented by `rev`.
 *     onesystem does not start these; it only calls them.
 *
 * The split is the whole point of the `backends` map: adding a model is a config
 * entry, not a code change. `laya` and `rev` are interchangeable at the tool boundary
 * because both are surfaced as MCP tools.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { HealthReport } from "./health.ts"
import { planNames } from "./naming.ts"
import type { Holder as LockHolder } from "./lock.ts"
import type { RoutingConfig } from "./routing.ts"

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

export type Backend = StdioBackend | SystemOneBackend

export interface Config {
  /**
   * Where the daemon listens. Must resolve to loopback.
   *
   * This endpoint has no auth, accepts no Origin check, and will read a request body of
   * any size — so a non-loopback bind publishes a model to the network. That was asserted
   * in a comment here, in `http.ts`, in the plugin, and in the README, and enforced
   * nowhere: `validate` took any string and `server.listen` bound it. `validate` now
   * refuses one.
   */
  host: string
  port: number
  /**
   * Shut a backend down after this long with no traffic. The whole daemon exits once
   * nothing is warm, which is what releases the port and the GPU.
   */
  idleShutdownSecs: number
  /**
   * Sweep interval for the idle check. Small; the check is a timestamp compare.
   *
   * Related to `idleShutdownSecs` by being compared against a timestamp that the sweep
   * reads, not by needing to be smaller: a sweep coarser than the window just means the
   * daemon exits up to one interval late, which is harmless. What must not happen is a
   * window so short that a request which has just completed gets reaped by the very tick
   * that first observes the backend warm — hence the check in `validate`.
   */
  idleSweepSecs: number
  /** Ceiling on one forwarded MCP call. Mirrors LAYA_TOOL_TIMEOUT_SECS. */
  requestTimeoutSecs: number
  backends: Record<string, Backend & { enabled?: boolean }>
  /**
   * Which model answers when the agent has not said. See src/routing.ts.
   *
   * Optional and off unless `enabled` is true, and ignored entirely unless more than one
   * backend is on — a routing config with a single model is not a degraded route, it is no
   * route, and reading as active while doing nothing is worse than not existing.
   */
  routing?: RoutingConfig
}

export const DEFAULTS: Config = {
  // High enough to be unlikely to collide with anything else on a workstation.
  port: 7331,
  host: "127.0.0.1",
  idleShutdownSecs: 600,
  idleSweepSecs: 5,
  requestTimeoutSecs: 120,
  backends: {},
}

/**
 * Loopback addresses this daemon is allowed to bind.
 *
 * `localhost` is included because it is what a person would type, but it is only
 * equivalent to `127.0.0.1` if it resolves there — so it is resolved rather than trusted.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (LOOPBACK_HOSTS.has(bare)) return true
  // 127.0.0.0/8 is all loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/**
 * The daemon's base URL. Assembled once.
 *
 * This was built in three places from a `Config` — here, in the CLI, and in the plugin
 * from environment variables no daemon code reads — so a user who set `port` in the config
 * and a user who set `ONESYSTEM_PORT` got two daemons' worth of disagreement, and the
 * symptom was an MCP server registered against a port nothing was listening on. The
 * plugin now reads the URL out of `onesystem status` instead of deriving one.
 */
export function daemonUrl(config: Config, port: number = config.port): string {
  const host = config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host
  return `http://${host}:${port}`
}


export function configDir(): string {
  return process.env.ONESYSTEM_CONFIG_DIR ?? join(homedir(), ".config", "onesystem")
}

export function stateDir(): string {
  return process.env.ONESYSTEM_STATE_DIR ?? join(homedir(), ".local", "state", "onesystem")
}

export function lockPath(): string {
  return join(stateDir(), "daemon.lock")
}

export function defaultConfigPath(): string {
  return join(configDir(), "onesystem.json")
}

export interface BackendRegistration {
  /** Backend name, as used in the URL path `/mcp/<backend>`. */
  backend: string
  /** Name opencode should register the MCP server under. */
  serverName: string
  /** Prefix stripped from this backend's tool names, if any. */
  toolPrefix?: string
  transport: Transport
}

/**
 * Work out what opencode should register, and how tools should be named.
 *
 * Lives here rather than in the plugin so the plugin does not have to re-derive it,
 * and so `onesystem status` can report the same names the plugin will actually use.
 * A mismatch there is the kind of thing that is only noticed when a tool is missing.
 *
 * The rule itself is in `naming.ts`, because this is no longer the only place that needs
 * it: the routing decision and the tool-name plan were each deriving a name independently,
 * and `routing.resolve` was inventing `onesystem` for a backend this function had already
 * named `onesystem-laya`. One rule, three readers.
 *
 * No `preferred` is passed, deliberately. A server name does not depend on which backend
 * is the routing default — that affects which *tools* are bare, not what the server is
 * called — so `onesystem status` reports the same names whether routing is on or off, and
 * cannot drift because of it.
 */
export function registrations(config: Config): BackendRegistration[] {
  const enabled = Object.entries(config.backends).filter(([, spec]) => spec.enabled !== false)
  const planned = planNames(enabled.map(([backend, spec]) => ({ backend, serverName: spec.serverName })))
  return planned.map((name) => {
    const spec = config.backends[name.backend]!
    return {
      backend: name.backend,
      // One backend gets the clean name. Several cannot all be `onesystem`, so the rest
      // are qualified rather than silently overwriting each other in opencode's registry.
      serverName: name.serverName,
      toolPrefix: spec.toolPrefix,
      transport: spec.transport,
    }
  })
}

/** Where a bundled example lives, used when the user has no config yet. */
export function shippedConfigPath(): string {
  return new URL("../onesystem.config.json", import.meta.url).pathname
}

/**
 * Every path `loadConfig` would try, in order.
 *
 * The first is what a person means by "my onesystem config"; the second is the bundled
 * example, so a fresh checkout runs without being told where anything is. `config-path`
 * prints all of them with which one is in use, because the old helper returned only the
 * first and claimed to be "the config file that would be used" — which is false for
 * exactly the users most likely to run it, those with no config file yet.
 */
export function configCandidates(path?: string): string[] {
  return path ? [path] : [defaultConfigPath(), shippedConfigPath()]
}

function requireNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The port, where zero means "let the kernel pick".
 *
 * Zero is a real port request rather than a nonsense one, and it is the only way to run
 * two daemons on one machine without picking a free port by hand — which is what every
 * test file was doing, each with its own `7000 + random()` guess and a matching chance
 * of colliding with something. So it is allowed here and nowhere else.
 */
function requirePort(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${field} must be an integer in 0-65535, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate rather than coerce.
 *
 * A silently-defaulted backend command is the failure mode worth preventing: the
 * daemon would start, answer requests, and be talking to nothing. Better to refuse to
 * boot and name the field.
 */
export function validate(raw: unknown, source: string): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: expected a JSON object`)
  }
  const input = raw as Record<string, unknown>

  const backends: Config["backends"] = {}
  const rawBackends = (input.backends ?? {}) as Record<string, unknown>
  for (const [name, value] of Object.entries(rawBackends)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${source}: backends.${name} must be an object`)
    }
    const entry = value as Record<string, unknown>
    const transport = entry.transport
    if (transport === "stdio-mcp") {
      const command = entry.command
      if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== "string")) {
        throw new Error(
          `${source}: backends.${name}.command must be a non-empty string array for a stdio-mcp backend`,
        )
      }
      // Required rather than defaulted. The tool surface cannot be discovered without
      // starting the process, and starting the process is the cost the lazy-start contract
      // forbids on this path — so an empty list here would mean a session that registers
      // no tools, with a healthy daemon and no error to explain it. That is the silent
      // failure worth refusing instead.
      const tools = entry.tools
      if (!Array.isArray(tools) || tools.length === 0 || tools.some((t) => typeof t !== "string" || t.length === 0)) {
        throw new Error(
          `${source}: backends.${name}.tools must be a non-empty string array, naming the tools ` +
            `this backend exposes without its product prefix (e.g. ["predict", "status"]).\n` +
            `onesystem cannot discover these at startup: reading them from the model is the ` +
            `20-54s load and 3 GB of VRAM that lazy start exists to avoid, so they are ` +
            `declared here. Run \`onesystem status\` after a first call to see what the model ` +
            `actually publishes, and add anything missing here.`,
        )
      }
      backends[name] = {
        transport,
        command: command as string[],
        env: entry.env as Record<string, string> | undefined,
        cwd: entry.cwd as string | undefined,
        startupTimeoutSecs: requireNumber(
          entry.startupTimeoutSecs,
          `${source}: backends.${name}.startupTimeoutSecs`,
          180,
        ),
        toolPrefix: entry.toolPrefix as string | undefined,
        serverName: entry.serverName as string | undefined,
        tools: tools as string[],
        enabled: entry.enabled !== false,
      }
    } else if (transport === "systemone-http") {
      if (typeof entry.baseUrl !== "string" || !entry.baseUrl.startsWith("http")) {
        throw new Error(`${source}: backends.${name}.baseUrl must be an http(s) URL`)
      }
      backends[name] = {
        transport,
        baseUrl: entry.baseUrl.replace(/\/+$/, ""),
        startupTimeoutSecs: requireNumber(
          entry.startupTimeoutSecs,
          `${source}: backends.${name}.startupTimeoutSecs`,
          30,
        ),
        toolPrefix: entry.toolPrefix as string | undefined,
        serverName: entry.serverName as string | undefined,
        enabled: entry.enabled !== false,
      }
    } else {
      throw new Error(
        `${source}: backends.${name}.transport must be "stdio-mcp" or "systemone-http", ` +
          `got ${JSON.stringify(transport)}`,
      )
    }
  }

  const host = typeof input.host === "string" ? input.host : DEFAULTS.host
  if (!isLoopbackHost(host)) {
    throw new Error(
      `${source}: host must be a loopback address (127.0.0.1, ::1, localhost), ` +
        `got ${JSON.stringify(host)}. This endpoint has no auth; binding it publicly ` +
        `would expose a model to the network.`,
    )
  }

  const idleShutdownSecs = requireNumber(
    input.idleShutdownSecs,
    `${source}: idleShutdownSecs`,
    DEFAULTS.idleShutdownSecs,
  )
  const idleSweepSecs = requireNumber(
    input.idleSweepSecs,
    `${source}: idleSweepSecs`,
    DEFAULTS.idleSweepSecs,
  )
  if (idleSweepSecs > idleShutdownSecs) {
    // Not fatal on its own — a coarse sweep only makes shutdown late — but a window this
    // short means the tick which first notices a backend warm can also decide it went
    // quiet, which winds the daemon down under a request that just completed. Say so at
    // load time instead of leaving it to be diagnosed as a daemon that will not stay up.
    throw new Error(
      `${source}: idleSweepSecs (${idleSweepSecs}) must not exceed idleShutdownSecs ` +
        `(${idleShutdownSecs}); a sweep coarser than the window can reap a backend on the ` +
        `same tick that first observes it warm.`,
    )
  }

  return {
    host,
    port: requirePort(input.port, `${source}: port`, DEFAULTS.port),
    idleShutdownSecs,
    idleSweepSecs,
    requestTimeoutSecs: requireNumber(
      input.requestTimeoutSecs,
      `${source}: requestTimeoutSecs`,
      DEFAULTS.requestTimeoutSecs,
    ),
    backends,
    routing: readRouting(input.routing),
  }
}

/**
 * Read the routing block, or omit it.
 *
 * Omitted rather than defaulted to `{enabled: false}` so that "no routing" and "routing
 * explicitly off" are the same object, and `routing` stays undefined unless someone
 * actually wrote one.
 */
function readRouting(raw: unknown): RoutingConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const input = raw as Record<string, unknown>
  const tasks: Record<string, string> = {}
  if (typeof input.tasks === "object" && input.tasks !== null) {
    for (const [task, model] of Object.entries(input.tasks as Record<string, unknown>)) {
      if (typeof model === "string") tasks[task] = model
    }
  }
  const out: RoutingConfig = {
    enabled: input.enabled === true,
    default: typeof input.default === "string" ? input.default : undefined,
    tasks: Object.keys(tasks).length > 0 ? tasks : undefined,
  }
  return out.enabled || out.default || out.tasks ? out : undefined
}

/**
 * Everything `onesystem status` reports, which is the whole of what the opencode plugin
 * knows about the daemon.
 *
 * This type lives here, next to the rules that produce it, rather than being re-spelled
 * as an anonymous object in the CLI and parsed as a second anonymous object in the
 * plugin. Nothing checked that the two agreed, so `registrations` could gain a field the
 * plugin ignored — and did: `toolPrefix` is produced here and discarded there, which is
 * the sort of drift this whole arrangement exists to prevent.
 *
 * It is also how the plugin stops guessing the address. `url` is the one true answer,
 * computed from the config the daemon actually loaded.
 */
export interface DaemonStatus {
  /** The config file in use. */
  config: string
  /** Every path that would be tried, in order. */
  configCandidates: string[]
  configDir: string
  /** Base URL the daemon answers on. */
  url: string
  running: boolean
  /** The health report, or null when nothing is listening. */
  daemon: HealthReport | null
  /** Who holds the lock, if anyone. */
  lock: LockHolder | null
  /** What opencode should register, and under which names. */
  registrations: BackendRegistration[]
  idleShutdownSecs: number
  /** Present only when the config declares one; omitted otherwise. */
  routing?: RoutingConfig
}

export async function loadConfig(path?: string): Promise<{ config: Config; path: string }> {
  const candidates = configCandidates(path)
  const tried: string[] = []
  for (const candidate of candidates) {
    tried.push(candidate)
    let text: string
    try {
      text = await readFile(candidate, "utf8")
    } catch {
      continue
    }
    return { config: validate(parseConfig(text, candidate), candidate), path: candidate }
  }
  throw new Error(`no onesystem config found; looked in:\n  ${tried.join("\n  ")}`)
}

/**
 * Parse as JSONC so the config can carry the comments that explain the timings.
 *
 * A hand-rolled comment-stripping regex was the first attempt and it is the wrong tool:
 * `//` appears inside strings (every baseUrl), so any regex has to know about string
 * context, and getting that subtly wrong corrupts values silently.
 */
function parseConfig(text: string, source: string): unknown {
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true }) as unknown
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`${source}: invalid JSON at offset ${first.offset}: ${printParseErrorCode(first.error)}`)
  }
  return parsed
}
