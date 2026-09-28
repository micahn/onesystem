/**
 * What a backend and its tools are called.
 *
 * Three modules were answering that question with three different rules, and one of them
 * ignored the answer it was handed:
 *
 *   - `config.registrations` — `spec.serverName ?? (single ? "onesystem" :
 *     `onesystem-${backend}`)`. The only one that honours an explicit `serverName`.
 *   - `routing.resolve` — `onesystem-${b.backend}` hardcoded, and `preferredServerName:
 *     "onesystem"` hardcoded. It never read the `serverName` field it was passed, so a
 *     config with `serverName: "decisions"` was reported correctly by `onesystem status`
 *     and silently discarded by the routing path.
 *   - `planTools` — a third spelling again, and a rule the other two had no equivalent of:
 *     which backend keeps the bare, unqualified tool names.
 *
 * With two backends and routing on, those three produced three names for one backend: the
 * registration said `onesystem-laya`, the routing decision said `onesystem`, and the tool
 * was registered as `predict`. Nothing errored, because each of the three was internally
 * consistent and none of them was talking to the others.
 *
 * ## Two questions, one decision
 *
 * A *server* name and a *tool* name are different things, and conflating them is how the
 * rules drifted. But they are not independent: "which backend is the unqualified one" is
 * the same question for both, and answering it in two places is what let them disagree.
 * So this module answers it once, and `registrations` and `planTools` both read it.
 *
 * ## What it deliberately does not do
 *
 * It does not decide whether routing is on — that is `routing.isEnabled`, and it is a
 * question about config rather than about names. It takes the preferred backend as a plain
 * string so that this module has no opinion about routing, and no import of it, and
 * therefore no cycle with the module that calls it.
 *
 * `registrations` and `BackendRegistration` arrived here from `config.ts`, which is where
 * they used to live for the same reason the three rules drifted apart: one namespace, four
 * subjects, and the one holding the rule had no reason to hold the policy. What is left in
 * `config.ts` is the config *file* — the declared shape, `validate`, and `loadConfig`.
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
   * Whether this backend's tools keep their bare, unqualified names.
   *
   * True for the only backend when there is one, and for the preferred backend when
   * several are configured and one is declared as the default. False for everything else,
   * which is what stops two backends claiming `predict` and one silently winning.
   */
  bare: boolean
}

/** The unprefixed server name. One constant, because three modules used to spell it. */
const BARE_SERVER = "onesystem"

/**
 * Work out the names for a set of backends.
 *
 * `preferred` is the backend that should keep the bare tool names, or undefined when
 * nothing was declared. Note what undefined means when there are several backends: *none*
 * of them is bare. That is not an oversight — it is the current behaviour of `planTools`,
 * and it is the right one. A declared default is a claim somebody made; with no claim
 * there is nothing to justify one backend being unqualified, so all of them are qualified
 * and the agent picks. Changing it would rename every tool in every live session on a
 * two-backend setup, which is a change to be made deliberately or not at all.
 */
export function planNames(candidates: readonly NameCandidate[], preferred?: string): PlannedName[] {
  const single = candidates.length === 1
  return candidates.map((c) => ({
    backend: c.backend,
    // An explicit name is the user's decision and is never second-guessed. Everything else
    // is derived from the one question of how many backends there are.
    serverName: c.serverName ?? (single ? BARE_SERVER : `${BARE_SERVER}-${c.backend}`),
    bare: single || (preferred !== undefined && c.backend === preferred),
  }))
}

/**
 * What opencode should register, and how.
 *
 * The other half of this module's answer, for the machine rather than the agent: a *server*
 * name, the prefix stripped from tool names, and the transport.
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
 * Work out what opencode should register, from the backends the config declares.
 *
 * Takes the `backends` map rather than a `Config`, which is the smaller interface and the
 * one that makes this testable: a test can pass a literal and get names out, with no
 * validator in between. It used to take a `Config`, which meant `naming.ts` had to import
 * `config.ts` while `config.ts` imported `naming.ts` for the naming rule — a type cycle
 * created by two modules each wanting the other's subject.
 *
 * That it takes the declared backends and not the *enabled* ones is deliberate, and is why
 * the argument is a map: which of them are enabled is a question about the config, answered
 * here from `enabled !== false`, so a caller cannot pass a list that has quietly been
 * filtered wrong.
 */
export function registrations(backends: Record<string, ConfiguredBackend>): BackendRegistration[] {
  const enabled = Object.entries(backends).filter(([, spec]) => spec.enabled !== false)
  const planned = planNames(enabled.map(([backend, spec]) => ({ backend, serverName: spec.serverName })))
  return planned.map((name) => {
    const spec = backends[name.backend]!
    return {
      backend: name.backend,
      // One backend gets the clean name. Several cannot all be `onesystem`, so the rest are
      // qualified rather than silently overwriting each other in opencode's registry.
      serverName: name.serverName,
      toolPrefix: spec.toolPrefix,
      transport: spec.transport,
    }
  })
}
