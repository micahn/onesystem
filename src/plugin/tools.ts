/**
 * Registering the models as native tools instead of as MCP servers.
 *
 * ## Why not just let opencode speak MCP to the daemon
 *
 * It worked, and it cost two things. Every backend appeared in opencode's own MCP server
 * list, so a two-model setup put two entries in the sidebar the user opens to see what is
 * connected — clutter for a service that is conceptually one thing. And a tool the host
 * can host natively was being hosted twice, over a protocol whose session management,
 * SSE framing and capability negotiation all had to work correctly for a request that is
 * just "here is a state, here are questions, give me a label".
 *
 * The plugin can register a tool directly, so the daemon does not need to be an MCP server
 * for opencode's benefit. It still is one, for everything else's.
 *
 * ## The schemas are declared, not discovered
 *
 * This used to fetch the model's own `tools/list` through the daemon and hand the schema
 * straight through, on the reasoning that laya went from 0.3.10 to 0.3.21 during this
 * project and a hand-written copy would be wrong within a release. The reasoning was
 * sound and the premise was not: forwarding `tools/list` reaches the process, so reading
 * the catalog at session start paid the 20-54s model load this project exists to keep off
 * that path. `/catalog` now serves a surface declared in config, which loads nothing, and
 * the schema here is a pass-through.
 *
 * The cost is a declared list that can go stale against a release. That is preferable to
 * the alternative and not by much of a margin: a stale name fails the call with the
 * backend's own "unknown tool" — loud, at the moment of the call — whereas the session
 * start that discovers tools by loading a model is quiet, costs three gigabytes, and
 * happens whether or not the agent ever asks a question.
 */

import type { Plugin } from "@opencode/plugin"
import { healthy } from "../health.ts"
import { planNames, type NameCandidate } from "../naming.ts"
import { run } from "./discover.ts"

export interface CatalogEntry {
  backend: string
  toolPrefix?: string
  tools?: { tools?: { name?: string; description?: string; inputSchema?: unknown }[] }
  error?: string
}

export interface Catalog {
  backends: CatalogEntry[]
}

export interface JsonTool {
  name: string
  description: string
  inputSchema: unknown
}

/**
 * Flatten the catalog into the tools to register, and decide what each one is called.
 *
 * One tool per model tool, not per backend: the prefix is stripped, so `laya_predict` and
 * a hypothetical `julia_predict` both become `predict` and a caller cannot tell which
 * model will answer. That is deliberate for a single model and wrong for two, so with more
 * than one backend the name is qualified and the agent picks.
 *
 * Which backends are qualified is not decided here. `naming.planNames` answers it, once,
 * for the server names and the tool names together, and this function supplies it with the
 * candidates. It used to re-derive the rule with a third spelling — `usable.length === 1 ?
 * bare : entry.backend === routingDefault ? bare : qualified` — which meant "which backend
 * is unqualified" had three implementations in the codebase and the routing one disagreed
 * with the other two about names. Asking instead of deriving is also what makes the
 * property test in `test/naming.test.ts` writable: there is finally a single answer to
 * compare against.
 *
 * `candidates` is the daemon's registrations, and it is consulted only for which backends
 * exist — a configured backend that is down must not count towards "more than one". With
 * two configured and one unreachable, the one that can still answer keeps the clean
 * `predict` name rather than being pushed to `laya_predict` by a backend that is not there.
 * That is why `planNames` is asked about the *usable* set below, and not about whatever
 * was configured.
 */
export function planTools(catalog: Catalog, candidates?: NameCandidate[], preferred?: string): {
  tools: { name: string; backend: string; tool: string; description: string; inputSchema: unknown }[]
  unreachable: { backend: string; error: string }[]
} {
  const tools: { name: string; backend: string; tool: string; description: string; inputSchema: unknown }[] = []
  const unreachable: { backend: string; error: string }[] = []
  const usable = catalog.backends.filter((b) => !b.error && (b.tools?.tools?.length ?? 0) > 0)

  // Usable, and known to the daemon. Falling back to the catalog alone keeps this callable
  // without registrations, which is the shape the plugin tests use.
  const answerable = candidates
    ? candidates.filter((c) => usable.some((u) => u.backend === c.backend))
    : usable.map((u) => ({ backend: u.backend }))
  const bare = new Set(planNames(answerable, preferred).filter((n) => n.bare).map((n) => n.backend))

  for (const entry of catalog.backends) {
    if (entry.error) {
      unreachable.push({ backend: entry.backend, error: entry.error })
      continue
    }
    for (const t of entry.tools?.tools ?? []) {
      if (typeof t.name !== "string") continue
      const stripped = entry.toolPrefix && t.name.startsWith(entry.toolPrefix)
        ? t.name.slice(entry.toolPrefix.length)
        : t.name
      // With one model, `predict` is the name. With several, an unqualified name would
      // make two models claim one tool, so only a declared preferred backend keeps it.
      const name = bare.has(entry.backend) ? stripped : `${entry.backend}_${stripped}`
      tools.push({
        name,
        backend: entry.backend,
        // The daemon strips its own prefix on the way out and restores it on the way in,
        // so the wire name is always the model's own.
        tool: t.name,
        description: t.description ?? `${entry.backend} ${stripped}`,
        inputSchema: t.inputSchema ?? { type: "object", additionalProperties: true },
      })
    }
  }
  return { tools, unreachable }
}

/** One call to the daemon's JSON front door. */
export async function callTool(
  base: string,
  backend: string,
  tool: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${base}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ backend, tool, arguments: args }),
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${backend} ${tool} failed (${res.status}): ${text.slice(0, 300)}`)
  // Unwrap to the model's own text, which is what the MCP path returned too — so the tool
  // result a session sees is unchanged by this refactor.
  try {
    const parsed = JSON.parse(text) as { result?: { content?: { type: string; text?: string }[] } }
    const block = parsed.result?.content?.[0]
    if (block?.text !== undefined) return block.text
  } catch {
    /* fall through to the raw body */
  }
  return text
}

/**
 * Read the daemon's declared tool surface.
 *
 * Inlined rather than kept as a module-level helper: one caller, and a try/catch — a
 * pass-through with no leverage. The bound is the point. This is the only call the plugin
 * makes at setup, and an unbounded one blocks session start forever against a daemon that
 * accepted the connection and then stopped answering. Nothing is loaded at that point, so
 * no model log line would say why it hung.
 */
async function readCatalog(base: string, timeoutMs: number): Promise<Catalog | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const res = await fetch(`${base}/catalog`, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as Catalog
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Register the catalog with opencode.
 *
 * Returns the disposer, and the names it registered, so the caller can match its recovery
 * hook and log what the session actually got.
 */
export async function registerTools(
  ctx: {
    tool: {
      transform: (cb: (editor: { add(t: unknown): void }) => void) => Promise<{ dispose(): Promise<void> }>
      reload: () => Promise<void>
    }
  },
  base: string,
  candidates: NameCandidate[] | undefined,
  preferred: string | undefined,
  catalogTimeoutMs = 10_000,
): Promise<{ dispose: () => Promise<void>; names: string[]; unreachable: { backend: string; error: string }[] }> {
  const catalog = await readCatalog(base, catalogTimeoutMs)
  if (!catalog) throw new Error(`could not read the tool catalog from ${base}/catalog`)

  const { tools, unreachable } = planTools(catalog, candidates, preferred)
  for (const u of unreachable) {
    // Logged rather than thrown: one backend being down should not cost the session the
    // tools of the others.
    process.stderr.write(`[onesystem:plugin] ${u.backend} is unreachable: ${u.error}\n`)
  }

  const registration = await ctx.tool.transform((editor) => {
    for (const t of tools) {
      editor.add({
        name: t.name,
        description: t.description,
        // The model's own JSON schema, passed straight through. `ValueSchema` accepts a
        // plain JSON schema, so there is nothing to translate and nothing to keep in sync.
        input: t.inputSchema,
        async execute(input: unknown, context: { signal?: AbortSignal }) {
          const text = await callTool(base, t.backend, t.tool, input, context?.signal)
          return { content: text }
        },
      })
    }
  })

  // `transform` alone does not make the tools visible. Unlike `mcp.transform`, which the
  // host applies immediately, a tool added from a plugin is staged until the tool registry
  // is reloaded -- without this the session runs with no tools and no error to explain it.
  await ctx.tool.reload().catch((err) => {
    process.stderr.write(`[onesystem:plugin] tool reload failed: ${String(err)}\n`)
  })

  return { dispose: () => registration.dispose(), names: tools.map((t) => t.name), unreachable }
}

export type { Plugin }
