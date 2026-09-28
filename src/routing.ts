/**
 * Select a default model for unqualified tools. Routing is off by default and
 * requires multiple enabled backends. The task map supplies logged guidance;
 * calls stay with the backend selected by the tool name.
 */

export interface RoutingConfig {
  enabled?: boolean
  /** Backend that answers when nothing else applies. */
  default?: string
  /** Free-form category -> backend. Advisory; see the module comment. */
  tasks?: Record<string, string>
}

export interface RoutingDecision {
  /** Backend for an unqualified call. */
  preferred: string
  /**
   * Preferred backend's server name, read from registrations.
   */
  preferredServerName: string
  /** Every other backend, qualified, in a stable order. */
  others: { backend: string; serverName: string }[]
  /** One line per task, for the agent. Empty when there is no map. */
  guidance: string[]
}

export function isEnabled(routing: RoutingConfig | undefined, backendCount: number): boolean {
  // A single backend needs no routing.
  return routing?.enabled === true && backendCount > 1
}

/**
 * Select the preferred backend, or return null when routing is off.
 * Use server names from `onesystem status`; naming.ts owns their format.
 */
export function resolve(
  routing: RoutingConfig | undefined,
  backends: { backend: string; serverName: string }[],
): RoutingDecision | null {
  if (!isEnabled(routing, backends.length)) return null

  const wanted = routing!.default
  // An unavailable default falls back to the first registration.
  const preferred = backends.find((b) => b.backend === wanted) ?? backends[0]!
  // Preserve explicit serverName values.
  const others = backends
    .filter((b) => b.backend !== preferred.backend)
    .map((b) => ({ backend: b.backend, serverName: b.serverName }))

  const guidance = Object.entries(routing!.tasks ?? {}).map(
    ([task, model]) => `  ${task}: ${model}`,
  )

  return { preferred: preferred.backend, preferredServerName: preferred.serverName, others, guidance }
}
