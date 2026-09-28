/**
 * Edit JSONC with jsonc-parser to preserve comments and unrelated settings.
 * Re-read before writing to detect concurrent edits.
 */

import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { Config } from "./config.ts"

/**
 * Set backends.<name>.enabled and return the edited text.
 */
export function setEnabled(text: string, backend: string, enabled: boolean): string {
  const errors: ParseError[] = []
  const doc = parse(text, errors) as Record<string, unknown> | undefined
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`config is not valid JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}`)
  }
  if (typeof doc !== "object" || doc === null) throw new Error("config is not a JSON object")

  const backends = (doc.backends ?? {}) as Record<string, unknown>
  if (!(backend in backends)) {
    throw new Error(`no backend named "${backend}" in the config; found: ${Object.keys(backends).join(", ") || "none"}`)
  }

  const edits = modify(text, ["backends", backend, "enabled"], enabled, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  return applyEdits(text, edits)
}

/** Which backends exist, and whether each is on. */
export function backendStates(config: Config): { name: string; enabled: boolean }[] {
  return Object.entries(config.backends).map(([name, spec]) => ({ name, enabled: spec.enabled !== false }))
}

/**
 * Enable one backend and disable the others. Shared by the CLI and TUI.
 * Throw with the available names if the requested backend is missing.
 */
export async function switchToBackend(
  path: string,
  config: Config,
  name: string,
): Promise<{ changed: boolean; on: string[]; off: string[] }> {
  const states = backendStates(config)
  if (!states.some((s) => s.name === name)) {
    throw new Error(
      `no backend named "${name}" in ${path}; found: ${states.map((s) => s.name).join(", ") || "none"}`,
    )
  }

  const next = states.map((s) => ({ name: s.name, enabled: s.name === name }))
  const result = await editConfig(path, (text) =>
    next.reduce((acc, s) => setEnabled(acc, s.name, s.enabled), text),
  )
  return {
    changed: result.changed,
    on: next.filter((s) => s.enabled).map((s) => s.name),
    off: next.filter((s) => !s.enabled).map((s) => s.name),
  }
}

/**
 * Write an edit only if a second read matches the original file.
 */
export async function editConfig(
  path: string,
  mutate: (text: string) => string,
): Promise<{ changed: boolean; before: string; after: string }> {
  const before = await readFile(path, "utf8")
  const after = mutate(before)
  if (after === before) return { changed: false, before, after }

  // Confirm the file still says what we read, by re-reading and comparing.
  const current = await readFile(path, "utf8")
  if (current !== before) {
    throw new Error(`${path} changed while this command was running; not writing over it. Re-run.`)
  }
  await writeFile(path, after)
  return { changed: true, before, after }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * The entrypoints OpenCode discovers, one file per plugin half. Re-exports of the checkout,
 * so `git pull` is live and a moved checkout self-heals on the next run.
 */
export function pluginAutoloadFiles(): {
  dir: string
  files: { path: string; contents: string }[]
} {
  // OPENCODE_CONFIG_DIR is the config directory, so the plugins dir is a level under it.
  const base = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode")
  const dir = join(base, "plugins", "onesystem")
  const from = (name: string) => fileURLToPath(new URL(`../src/plugin/${name}.ts`, import.meta.url))
  const reexport = (name: string) => `export { default } from ${JSON.stringify(from(name))}\n`
  return {
    dir,
    files: [
      { path: join(dir, "index.ts"), contents: reexport("index") },
      { path: join(dir, "tui.ts"), contents: reexport("tui") },
    ],
  }
}

/**
 * Write an installed backend. Merge fields and env keys by default; replace tools.
 * With merge: false, replace the block. Preserve enabled unless explicitly supplied.
 */
export async function writeBackend(
  path: string,
  name: string,
  backend: unknown,
  options: { enabled?: boolean; merge?: boolean } = {},
): Promise<{ changed: boolean }> {
  const { merge = true, enabled } = options
  const result = await editConfig(path, (text) => {
    const errors: ParseError[] = []
    const doc = parse(text, errors) as Record<string, unknown> | undefined
    if (errors.length > 0) {
      const first = errors[0]!
      throw new Error(
        `config is not valid JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}`,
      )
    }
    if (typeof doc !== "object" || doc === null) throw new Error("config is not a JSON object")

    const backends = (doc.backends ?? {}) as Record<string, Record<string, unknown>>
    const existing = backends[name]

    let next: Record<string, unknown>
    if (merge && existing && typeof existing === "object") {
      next = { ...existing, ...(backend as Record<string, unknown>) }
      // Keep user env settings such as LAYA_PRELOAD. Replace tool lists so removed
      // names are no longer advertised.
      const incoming = (backend as Record<string, unknown>).env
      if (isPlainObject(existing.env) && isPlainObject(incoming)) {
        next.env = { ...existing.env, ...incoming }
      }
    } else {
      next = { ...(backend as Record<string, unknown>) }
    }
    // Apply the requested state after the backend fields.
    if (enabled !== undefined) next.enabled = enabled
    // Otherwise preserve the user's enabled state.
    else if (existing && "enabled" in existing) next.enabled = existing.enabled

    return applyEdits(
      text,
      modify(text, ["backends", name], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    )
  })
  return { changed: result.changed }
}
