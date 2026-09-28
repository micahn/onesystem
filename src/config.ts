/**
 * The config file: what a person wrote, and whether it is allowed.
 *
 * This module used to be four subjects in one namespace -- path layout, naming policy,
 * validation, and the daemon's report schema -- which is 20 exports across 438 lines and
 * the widest interface in the codebase. The friction was never the module: `validate` is
 * genuinely deep, putting ~130 lines of refusal behaviour behind one small entry point, and
 * it is the best-tested thing here. The friction was the other three subjects sharing its
 * namespace, and one of them forcing a type cycle:
 *
 *     config.ts -> health.ts -> backend/types.ts -> config.ts
 *
 * Which is a strange thing for a config file to be doing. `DaemonStatus` is a *report* type
 * and it could only live here because this was the one module already importing the other
 * three. So it moved to `health.ts`, beside the report it embeds.
 *
 * What is left is one subject, and a coherent one: the declared shape (`Config`, `DEFAULTS`),
 * `validate`, which decides what may be said, and `loadConfig`, which finds and parses a
 * file. The rest went where it belonged -- `paths.ts` for where things live on disk,
 * `naming.ts` for what a backend is called, `backend/spec.ts` for what a backend *is*
 * (importing nothing, which is what closes the cycle), and `health.ts` for what the daemon
 * reports.
 *
 * ## Two backend transports
 *
 * Because the System 1 landscape of Sept 2026 does not agree on one:
 *
 *   - `stdio-mcp` -- a local process speaking MCP over stdin/stdout. This is what
 *     `laya` is, and it is the transport that needs a real local process.
 *   - `systemone-http` -- an already-running service speaking `POST /v1/systemone`,
 *     the spec published by TypeSafe's typesafe-sdk and implemented by `rev`.
 *     onesystem does not start these; it only calls them.
 *
 * The split is the whole point of the `backends` map: adding a model is a config
 * entry, not a code change. `laya` and `rev` are interchangeable at the tool boundary
 * because both are surfaced as MCP tools.
 */

import { readFile } from "node:fs/promises"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { ConfiguredBackend, Transport } from "./backend/spec.ts"
import { configCandidates } from "./paths.ts"
import type { RoutingConfig } from "./routing.ts"

// Re-exported so a caller that wants a backend's declared shape does not have to know
// which of the four modules it ended up in. The *values* moved; these names are still the
// obvious way to ask for the types, and keeping them here costs one line and saves a
// rename across five adapters and a dozen tests.
export type {
  BackendSpec,
  ConfiguredBackend,
  StdioBackend,
  SystemOneBackend,
  Transport,
} from "./backend/spec.ts"

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
  backends: Record<string, ConfiguredBackend>
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

/**
 * Is this a loopback address?
 *
 * `localhost` is allowed because it is what a person would type, but it is only equivalent
 * to `127.0.0.1` if it resolves there — so it is resolved rather than trusted.
 *
 * Not exported: `validate` is the only caller, and it is a refusal rule rather than a
 * vocabulary anyone else needs. It used to be exported from a module that also owned path
 * layout and the status schema, which is how a helper nobody outside the file uses ends up
 * looking like part of the interface.
 */
function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (LOOPBACK_HOSTS.has(bare)) return true
  // 127.0.0.0/8 is all loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
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
