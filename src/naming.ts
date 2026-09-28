/**
 * Shared server and tool naming rules. Both registrations and plugin tools use
 * planNames so they agree on which backend keeps unqualified names.
 * Routing supplies the preferred backend; this module only assigns names.
 */

import type { ConfiguredBackend, Transport } from "./backend/spec.ts"

export interface NameCandidate {
  backend: string
  /** An explicit name from config, if the user set one. Always wins. */
  serverName?: string
}

export interface PlannedName {
  backend: string
  /** The name opencode should register the MCP server under. */
  serverName: string
  /**
   * Keep unqualified tool names for the sole backend or the preferred backend.
   * Other backends need qualified names to avoid collisions.
   */
  bare: boolean
}

/** Default name for a single backend. */
const BARE_SERVER = "onesystem"

/**
 * Assign names. With several backends and no preferred backend, qualify every
 * tool name. Changing this rule renames tools in existing multi-backend setups.
 */
export function planNames(candidates: readonly NameCandidate[], preferred?: string): PlannedName[] {
  const single = candidates.length === 1
  return candidates.map((c) => ({
    backend: c.backend,
    // An explicit server name overrides the default.
    serverName: c.serverName ?? (single ? BARE_SERVER : `${BARE_SERVER}-${c.backend}`),
    bare: single || (preferred !== undefined && c.backend === preferred),
  }))
}

/**
 * Backend identity, server name, tool prefix, and transport for status consumers.
 */
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
 * Build registrations from the full backend map. Filter disabled entries here so
 * all callers use the same enabled set.
 */
export function registrations(backends: Record<string, ConfiguredBackend>): BackendRegistration[] {
  const enabled = Object.entries(backends).filter(([, spec]) => spec.enabled !== false)
  const planned = planNames(enabled.map(([backend, spec]) => ({ backend, serverName: spec.serverName })))
  return planned.map((name) => {
    const spec = backends[name.backend]!
    return {
      backend: name.backend,
      // Qualify server names when several backends are enabled.
      serverName: name.serverName,
      toolPrefix: spec.toolPrefix,
      transport: spec.transport,
    }
  })
}
