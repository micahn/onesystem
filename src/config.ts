/**
 * Load and validate JSONC config. Backend types live in backend/spec.ts;
 * paths, naming rules, and status payloads have separate modules.
 */

import { readFile } from "node:fs/promises"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { ConfiguredBackend, Transport } from "./backend/spec.ts"
import { configCandidates } from "./paths.ts"
import type { RoutingConfig } from "./routing.ts"

// Keep backend types available to existing config consumers.
export type {
  BackendSpec,
  ConfiguredBackend,
  StdioBackend,
  SystemOneBackend,
  Transport,
} from "./backend/spec.ts"

export interface Config {
  /**
   * Listen address. Validation permits only loopback because the service has no auth.
   */
  host: string
  port: number
  /**
   * Shut a backend down after this long with no traffic. The whole daemon exits once
   * nothing is warm, which is what releases the port and the GPU.
   */
  idleShutdownSecs: number
  /**
   * Seconds between idle checks. Must not exceed idleShutdownSecs.
   */
  idleSweepSecs: number
  /** Maximum seconds per forwarded call, enforced by the supervisor. */
  requestTimeoutSecs: number
  backends: Record<string, ConfiguredBackend>
  /**
   * Optional default model and task guidance. Requires enabled: true and multiple backends.
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

/** Accepted loopback host names. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

/** Check the host spelling; this does not perform a DNS lookup. */
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
 * Validate a TCP port. Zero asks the kernel for a free port, useful in tests.
 */
function requirePort(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${field} must be an integer in 0-65535, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Reject invalid values with the source and field name instead of coercing them.
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
      // Require a declared list so setup can register tools without starting the model.
      const tools = entry.tools
      if (!Array.isArray(tools) || tools.length === 0 || tools.some((t) => typeof t !== "string" || t.length === 0)) {
        throw new Error(
          `${source}: backends.${name}.tools must be a non-empty string array, naming the tools ` +
            `this backend exposes without its product prefix (e.g. ["predict", "status"]).\n` +
            `onesystem cannot discover these at startup without loading the model. ` +
            `Use the backend's MCP tools/list to inspect its tools; this starts the process.`,
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
    // Reject a sweep interval that can miss the entire idle window.
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
 * Omit routing unless it enables routing or declares a default or task map.
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
 * Parse JSONC with trailing commas. A comment-stripping regex would corrupt URL strings.
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
