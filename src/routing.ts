/**
 * Which model answers when the agent has not said.
 *
 * ## What routing can and cannot do here
 *
 * With two backends enabled, opencode registers one MCP server per backend
 * (`onesystem-laya`, `onesystem-julia`) and the agent picks by tool name. That is already
 * routing, done by whoever has the most context — which is usually right, because the agent
 * can see the question and you cannot.
 *
 * What this adds is a deterministic answer for the case where it does not choose: a
 * declared default, plus a task map the agent is told about so a deliberate choice is
 * informed. It cannot move a call between models mid-flight, and it does not try to.
 *
 * ## The two conditions it obeys
 *
 * **Off by default.** `enabled` is false unless said otherwise, because a default model is
 * a claim about which model is better, and that claim should be made by a person who has
 * looked at an A/B run rather than inherited from a config file.
 *
 * **A no-op with one backend.** With a single model there is nothing to route between, and
 * a setting that pretends otherwise is a setting that will read as active while doing
 * nothing. `resolve` returns null and the caller registers the ordinary per-backend servers.
 *
 * ## The task map is guidance, not enforcement
 *
 * `tasks` is surfaced to the agent rather than used to dispatch. Routing a call by
 * inspecting its text for a task name would be a classifier in front of a classifier, and
 * it would be wrong in a way nobody could debug. The map tells the agent "engineering goes
 * to laya, operations to julia" and lets it decide whether this is an engineering question.
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
  /** Server name for the preferred backend: the bare `onesystem`. */
  preferredServerName: string
  /** Every other backend, qualified, in a stable order. */
  others: { backend: string; serverName: string }[]
  /** One line per task, for the agent. Empty when there is no map. */
  guidance: string[]
}

export function isEnabled(routing: RoutingConfig | undefined, backendCount: number): boolean {
  // The second condition is the one that is easy to forget: a routing config with a single
  // backend is not a degraded route, it is no route at all.
  return routing?.enabled === true && backendCount > 1
}

/**
 * Work out the server names, or null when routing is off.
 *
 * `backends` is the list from `onesystem status`, already filtered to enabled ones.
 */
export function resolve(
  routing: RoutingConfig | undefined,
  backends: { backend: string; serverName: string }[],
): RoutingDecision | null {
  if (!isEnabled(routing, backends.length)) return null

  const wanted = routing!.default
  // Fall back to the first registered rather than refusing to start. A config naming a
  // backend that is not enabled is a typo, and the daemon should still come up.
  const preferred = backends.find((b) => b.backend === wanted) ?? backends[0]!
  const others = backends
    .filter((b) => b.backend !== preferred.backend)
    .map((b) => ({ backend: b.backend, serverName: `onesystem-${b.backend}` }))

  const guidance = Object.entries(routing!.tasks ?? {}).map(
    ([task, model]) => `  ${task}: ${model}`,
  )

  return { preferred: preferred.backend, preferredServerName: "onesystem", others, guidance }
}
