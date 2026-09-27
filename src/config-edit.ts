/**
 * Editing the config in place, without destroying the comments.
 *
 * The config is JSONC and every timing in it is annotated with why it is that number —
 * those comments are the reason the file is hand-editable rather than generated. So
 * nothing here rewrites the file: `jsonc-parser`'s `modify` computes a minimal edit and
 * `applyEdits` splices it in, leaving every comment and every unrelated byte alone.
 *
 * A round trip through `JSON.parse`/`JSON.stringify` would be shorter by about four lines
 * and would delete the file's entire value the first time anyone ran a command that
 * touched it.
 */

import { readFile, writeFile } from "node:fs/promises"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import type { Config } from "./config.ts"

/**
 * Set `backends.<name>.enabled` and return the new file text.
 *
 * The one knob that switches a model. Enabling a second backend does not need a new
 * mechanism: the tool surface namespaces itself per backend, and the daemon supervises
 * each one independently, so "switching" is a flag.
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
 * Write a config edit, refusing rather than clobbering.
 *
 * The re-read before writing is not paranoia about our own write: a person may have
 * edited the file since the daemon read it, and silently reverting their change because
 * we held a stale copy is worse than refusing. The file is small, so this costs a read.
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
