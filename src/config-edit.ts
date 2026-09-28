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
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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
 * Make one backend the only enabled one.
 *
 * "Switching" is a flag: enabling a second backend does not need a new mechanism, because
 * the tool surface namespaces itself per backend and the daemon supervises each one
 * independently. So switching is `enabled: true` on one and `false` on the rest, which is
 * what `setEnabled` has always done.
 *
 * What is new is that it lives here rather than inside the CLI's `cmdUse`. There was one
 * implementation, in the one command that needed it, and the TUI's install menu was one
 * call short of using it: the menu installed a model and then told you to hand-edit the
 * config, while its own description promised "install and switch". A module that is
 * excellent at a thing and is on one code path is a module waiting for its second caller,
 * not a module with a bad interface — so this is the second caller.
 *
 * Throws rather than returning a failure, and the message names the backends that do exist,
 * because the overwhelmingly likely cause is a typo and a list is the whole of the answer.
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

/**
 * Put an installed model into the config, so nobody has to paste anything.
 *
 * `onesystem install` used to print the block and stop. The README then told you to copy
 * it, and the copy was the one step in the whole flow that could go wrong in a way nothing
 * detected: a block missing a key still looks like a config, the daemon still starts, and
 * the failure surfaces as an error payload on the first tool call rather than as a config
 * error. Printing a snippet and calling that the last step is a manual step, and the
 * machinery to do it properly was already here -- `modify` and `applyEdits` keep every
 * comment, so the file stays hand-editable.
 *
 * The backend is replaced wholesale rather than merged field by field. A partial merge
 * would have to decide what to do about a key the old block had and the new one does not,
 * and the answer that is safe in general -- keep it -- is also the answer that leaves a
 * stale `command` pointing at a deleted runtime. Replacing means the config always
 * describes the runtime that is actually on disk.
 *
 * `merge: false` is available because `rev` and a hand-written `laya` block are worth
 * keeping as they are, and this should not be the thing that makes that impossible.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Remove this repo's plugin from an opencode config, if it is listed there.
 *
 * opencode V2 autodiscovers plugins in `~/.config/opencode/plugins/`, so onesystem is
 * registered by a file there rather than by an entry in `opencode.json`. The config entry
 * is what this removes, and it is the tail of an earlier design: the plugin was originally
 * added to the `plugins` array, which meant editing a hand-maintained JSONC file to install
 * anything at all.
 *
 * Still an edit rather than a `sed`, for the reason every other function in this file is:
 * `opencode.json` is JSONC with comments and unrelated keys in it, and rewriting it through
 * `JSON.parse` destroys both. This runs once per install, to clean up after the old way.
 *
 * Returns whether anything was removed, so a caller can say "already correct" rather than
 * claiming a change it did not make.
 */
export function unregisterPlugin(
  text: string,
  pluginPath: string,
): { text: string; removed: number } {
  const errors: ParseError[] = []
  const doc = parse(text, errors) as Record<string, unknown> | undefined
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`not valid JSONC at offset ${first.offset}: ${printParseErrorCode(first.error)}`)
  }
  // Narrowed to an array explicitly rather than trusted: `plugins` is attacker-adjacent
  // input in the sense that matters here, it is a file a person edits, and a non-array value
  // has to be left alone rather than coerced.
  if (doc === undefined || !Array.isArray(doc.plugins)) return { text, removed: 0 }

  const list = doc.plugins as unknown[]
  const target = resolve(pluginPath)
  const keep = list.filter(
    (e) => !(isPlainObject(e) && typeof e.package === "string" && resolve(e.package) === target),
  )
  if (keep.length === list.length) return { text, removed: 0 }

  return {
    text: applyEdits(
      text,
      modify(text, ["plugins"], keep, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    ),
    removed: list.length - keep.length,
  }
}

/**
 * The autodetect file that registers this plugin with opencode.
 *
 * opencode V2 loads any `.ts` or `.js` file in `~/.config/opencode/plugins/`, so registering
 * is a one-line re-export of the plugin from wherever it happens to be checked out.
 *
 * Not a symlink: autodetection does not follow one. Not a copy of the source either, for two
 * reasons. The plugin imports `../health.ts` and friends and derives its own CLI path from
 * `../cli.ts`, so a copy of `src/plugin/` alone would not resolve its own imports, and a copy
 * of the whole tree would be a second, silently stale copy of the code the plugin actually
 * runs. A re-export is one file that always reads the checkout, so `git pull` takes effect on
 * the next reload instead of after a re-copy nobody remembers to do.
 */
export function pluginAutoloadFile(): { path: string; contents: string } {
  const dir = join(
    process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode"),
    "plugins",
  )
  const entry = fileURLToPath(new URL("../src/plugin/index.ts", import.meta.url))
  return { path: join(dir, "onesystem.ts"), contents: `export { default } from ${JSON.stringify(entry)}\n` }
}

/** Where opencode keeps its config. `OPENCODE_CONFIG` overrides, for a test or a second home. */
export function opencodeConfigPath(): string {
  return process.env.OPENCODE_CONFIG ?? join(homedir(), ".config", "opencode", "opencode.json")
}

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
      // `env` merges key by key rather than being replaced with the new block. It is a bag
      // of settings and the installer only knows the two or three it has to set, so
      // replacing it wholesale drops whatever a person put there: `LAYA_PRELOAD: "0"` is
      // load-bearing, because it is what keeps the model from loading outside a request.
      //
      // `tools` deliberately does not merge. The model is authoritative about its own
      // surface, and a union of two lists advertises names one of them has dropped.
      const incoming = (backend as Record<string, unknown>).env
      if (isPlainObject(existing.env) && isPlainObject(incoming)) {
        next.env = { ...existing.env, ...incoming }
      }
    } else {
      next = { ...(backend as Record<string, unknown>) }
    }
    // `enabled` is the switch, not part of the model's shape, so it is applied last and
    // survives a replacement of everything else.
    if (enabled !== undefined) next.enabled = enabled
    // Preserved from whatever was there: a replacement must not silently turn a model off
    // just because the block that described it was rewritten.
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
