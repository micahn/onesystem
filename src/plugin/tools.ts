/**
 * Register native OpenCode tools from the daemon's declared catalog.
 * Reading `/catalog` loads no model. Arguments pass through for backend validation;
 * stale tool names fail at call time. MCP remains available to other clients.
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
 * Flatten the catalog into named tools. Use naming.planNames on usable candidates
 * so an unavailable backend does not force the remaining backend's names to change.
 */
export function planTools(catalog: Catalog, candidates?: NameCandidate[], preferred?: string): {
  tools: { name: string; backend: string; tool: string; description: string; inputSchema: unknown }[]
  unreachable: { backend: string; error: string }[]
} {
  const tools: { name: string; backend: string; tool: string; description: string; inputSchema: unknown }[] = []
  const unreachable: { backend: string; error: string }[] = []
  const usable = catalog.backends.filter((b) => !b.error && (b.tools?.tools?.length ?? 0) > 0)

  // Without registrations, use the catalog as the candidate list.
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
      // Qualify names unless the shared plan gives this backend bare names.
      const name = bare.has(entry.backend) ? stripped : `${entry.backend}_${stripped}`
      tools.push({
        name,
        backend: entry.backend,
        // /call expects the backend's original, prefixed name.
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
  // Return the first text block, or the raw response if no text block exists.
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
 * Read the declared catalog with a timeout so an unresponsive daemon cannot block setup.
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
 * Register tools and return their names and cleanup function for the recovery hook.
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
    // Keep tools from other backends available.
    process.stderr.write(`[onesystem:plugin] ${u.backend} is unreachable: ${u.error}\n`)
  }

  const registration = await ctx.tool.transform((editor) => {
    for (const t of tools) {
      editor.add({
        name: t.name,
        description: t.description,
        // OpenCode accepts the catalog's JSON schema directly.
        input: t.inputSchema,
        async execute(input: unknown, context: { signal?: AbortSignal }) {
          const text = await callTool(base, t.backend, t.tool, input, context?.signal)
          return { content: text }
        },
      })
    }
  })

  // Refresh the host's tool registry after registration.
  await ctx.tool.reload().catch((err) => {
    process.stderr.write(`[onesystem:plugin] tool reload failed: ${String(err)}\n`)
  })

  return { dispose: () => registration.dispose(), names: tools.map((t) => t.name), unreachable }
}

export type { Plugin }
