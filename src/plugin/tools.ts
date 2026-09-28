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
 * ## The schemas are not ours
 *
 * The tempting version of this is to hand-write `predict`'s input schema in TypeScript. It
 * would be wrong within a release: laya went from 0.3.10 to 0.3.21 during this project and
 * changed its surface, adding `decide` and taking a different shape for `state`. So the
 * catalog is fetched from the daemon, which forwards the model's own `tools/list`, and the
 * schema opencode sees is the one the model published. There is nothing here to keep in
 * step with anything.
 */

import type { Plugin } from "@opencode/plugin"
import { healthy } from "../health.ts"
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
 */
export function planTools(catalog: Catalog, routingDefault?: string): {
  tools: { name: string; backend: string; tool: string; description: string; inputSchema: unknown }[]
  unreachable: { backend: string; error: string }[]
} {
  const tools: { name: string; backend: string; tool: string; description: string; inputSchema: unknown }[] = []
  const unreachable: { backend: string; error: string }[] = []
  const usable = catalog.backends.filter((b) => !b.error && (b.tools?.tools?.length ?? 0) > 0)

  for (const entry of catalog.backends) {
    if (entry.error) {
      unreachable.push({ backend: entry.backend, error: entry.error })
      continue
    }
    for (const t of entry.tools?.tools ?? []) {
      if (typeof t.name !== "string") continue
      const bare = entry.toolPrefix && t.name.startsWith(entry.toolPrefix)
        ? t.name.slice(entry.toolPrefix.length)
        : t.name
      // With one model, `predict` is the name. With several, an unqualified name would
      // make two models claim one tool, so the preferred model keeps the bare name and
      // the rest are qualified.
      const name =
        usable.length === 1
          ? bare
          : entry.backend === routingDefault
            ? bare
            : `${entry.backend}_${bare}`
      tools.push({
        name,
        backend: entry.backend,
        // The daemon strips its own prefix on the way out and restores it on the way in,
        // so the wire name is always the model's own.
        tool: t.name,
        description: t.description ?? `${entry.backend} ${bare}`,
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

export async function fetchCatalog(base: string, signal?: AbortSignal): Promise<Catalog | null> {
  try {
    const res = await fetch(`${base}/catalog`, { signal })
    if (!res.ok) return null
    return (await res.json()) as Catalog
  } catch {
    return null
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
  routingDefault: string | undefined,
): Promise<{ dispose: () => Promise<void>; names: string[]; unreachable: { backend: string; error: string }[] }> {
  const catalog = await fetchCatalog(base)
  if (!catalog) throw new Error(`could not read the tool catalog from ${base}/catalog`)

  const { tools, unreachable } = planTools(catalog, routingDefault)
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
