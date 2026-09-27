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

export type Transport = "stdio-mcp" | "systemone-http"

export interface StdioBackend {
  transport: "stdio-mcp"
  /** Executable plus args. First element is the program. */
  command: string[]
  env?: Record<string, string>
  cwd?: string
  /** Handshake budget for spawning this process and completing `initialize`. */
  startupTimeoutSecs?: number
}

export interface SystemOneBackend {
  transport: "systemone-http"
  /** Base URL of a running service, without the /v1/systemone path. */
  baseUrl: string
  startupTimeoutSecs?: number
}

export type Backend = StdioBackend | SystemOneBackend

export interface Config {
  /** Loopback only. Do not change this without adding auth. */
  host: string
  port: number
  /**
   * Shut a backend down after this long with no traffic. The whole daemon exits once
   * nothing is warm, which is what releases the port and the GPU.
   */
  idleShutdownSecs: number
  /** Sweep interval for the idle check. Small; the check is a timestamp compare. */
  idleSweepSecs: number
  /** Ceiling on one forwarded MCP call. Mirrors LAYA_TOOL_TIMEOUT_SECS. */
  requestTimeoutSecs: number
  backends: Record<string, Backend & { enabled?: boolean }>
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

/** Where a bundled example lives, used when the user has no config yet. */
export function shippedConfigPath(): string {
  return new URL("../onesystem.config.json", import.meta.url).pathname
}

/**
 * The config file that would be used, without needing to know whether it exists.
 * `onesystem config-path` prints this so tooling and the plugin can point at one file.
 */
export function configPathOrDefault(): string {
  return defaultConfigPath()
}

function requireNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number, got ${JSON.stringify(value)}`)
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
        enabled: entry.enabled !== false,
      }
    } else {
      throw new Error(
        `${source}: backends.${name}.transport must be "stdio-mcp" or "systemone-http", ` +
          `got ${JSON.stringify(transport)}`,
      )
    }
  }

  return {
    host: typeof input.host === "string" ? input.host : DEFAULTS.host,
    port: requireNumber(input.port, `${source}: port`, DEFAULTS.port),
    idleShutdownSecs: requireNumber(
      input.idleShutdownSecs,
      `${source}: idleShutdownSecs`,
      DEFAULTS.idleShutdownSecs,
    ),
    idleSweepSecs: requireNumber(input.idleSweepSecs, `${source}: idleSweepSecs`, DEFAULTS.idleSweepSecs),
    requestTimeoutSecs: requireNumber(
      input.requestTimeoutSecs,
      `${source}: requestTimeoutSecs`,
      DEFAULTS.requestTimeoutSecs,
    ),
    backends,
  }
}

export async function loadConfig(path?: string): Promise<{ config: Config; path: string }> {
  const candidates = path ? [path] : [defaultConfigPath(), shippedConfigPath()]
  const tried: string[] = []
  for (const candidate of candidates) {
    tried.push(candidate)
    let text: string
    try {
      text = await readFile(candidate, "utf8")
    } catch {
      continue
    }
    // Parsed as JSONC so the config can carry the comments that explain the timings.
    // A hand-rolled comment-stripping regex was the first attempt and it is the wrong
    // tool: `//` appears inside strings (every baseUrl), so any regex has to know about
    // string context, and getting that subtly wrong corrupts values silently.
    const errors: ParseError[] = []
    const parsed = parse(text, errors, { allowTrailingComma: true }) as unknown
    if (errors.length > 0) {
      const first = errors[0]!
      throw new Error(`${candidate}: invalid JSON at offset ${first.offset}: ${printParseErrorCode(first.error)}`)
    }
    return { config: validate(parsed, candidate), path: candidate }
  }
  throw new Error(`no onesystem config found; looked in:\n  ${tried.join("\n  ")}`)
}
