/**
 * Check that the CLI and TUI share model names, config switching, and unknown-name errors.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findModel, MODELS } from "../src/models.ts"
import { switchToBackend } from "../src/config-edit.ts"
import { validate } from "../src/config.ts"
import { parse } from "jsonc-parser"

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

/** The names the TUI menu offers, derived exactly as the menu derives them. */
const menuOffers = (): string[] => MODELS.map((m) => `install:${m.name}`).map((v) => v.slice("install:".length))

async function configFile(backends: Record<string, unknown>): Promise<{ path: string; config: ReturnType<typeof validate> }> {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-switch-"))
  dirs.push(dir)
  const path = join(dir, "onesystem.json")
  // Written with comments, because preserving them is the entire reason this edit goes
  // through `config-edit.ts` rather than a parse-and-reserialise.
  await writeFile(
    path,
    `{
  // Long on purpose: a model load costs 20-54s, so exiting sooner just moves the cost.
  "idleShutdownSecs": 600,
  "backends": ${JSON.stringify(backends, null, 2)}
}
`,
  )
  return { path, config: validate({ idleShutdownSecs: 600, backends }, path) }
}

describe("the menu and the CLI agree about names", () => {
  test("every name the menu offers is one the installer accepts", () => {
    // The menu builds its options from `MODELS` and the installer validates against
    // `findModel`, which reads the same array. That is the whole agreement, and asserting
    // it is what stops a fourth reader of the list from appearing and quietly disagreeing.
    for (const name of menuOffers()) {
      expect(() => findModel(name)).not.toThrow()
      expect(findModel(name).name).toBe(name)
    }
  })

  test("the menu offers every model, and nothing that is not a model", () => {
    expect(menuOffers().sort()).toEqual(MODELS.map((m) => m.name).sort())
  })

  test("an unknown name is refused the same way from both directions", () => {
    // One message, one list. A typo is the overwhelmingly likely cause and the list is the
    // whole of the answer, so the two paths saying different things about a typo is exactly
    // the sort of drift this file is here to catch.
    let fromModels: string | undefined
    try {
      findModel("nope")
    } catch (err) {
      fromModels = (err as Error).message
    }
    expect(fromModels).toMatch(/unknown model "nope"/)
    for (const m of MODELS) expect(fromModels).toContain(m.name)
  })
})

describe("switching", () => {
  test("it enables one backend and disables the rest", async () => {
    const { path, config } = await configFile({
      laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] },
      julia: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] },
    })
    const result = await switchToBackend(path, config, "julia")
    expect(result).toEqual({ changed: true, on: ["julia"], off: ["laya"] })

    // Parsed as JSONC, because the file it just wrote still has the comments in it -- which
    // is the point. `JSON.parse` here would fail, and would be the wrong thing to want.
    const after = validate(parse(await readFile(path, "utf8")), path)
    expect(after.backends.julia!.enabled).toBe(true)
    expect(after.backends.laya!.enabled).toBe(false)
  })

  test("it preserves the comments, which is the reason this is not a rewrite", async () => {
    // A `JSON.parse`/`stringify` round trip would pass the assertion above and delete the
    // file's entire value here. Those comments are the only record of why the timings are
    // what they are.
    const { path, config } = await configFile({
      laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] },
      julia: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] },
    })
    await switchToBackend(path, config, "julia")
    const after = await readFile(path, "utf8")
    expect(after).toContain("// Long on purpose: a model load costs 20-54s")
  })

  test("switching to the backend already enabled reports no change rather than rewriting", async () => {
    // Idempotent, and it says so. A menu that reports success for a no-op edit is a menu
    // that has rewritten the file to tell you it did nothing.
    // Both flags already written out explicitly, so setting them to the values they already
    // hold is genuinely a no-op. (A backend with no `enabled` key is *on*, but writing
    // `enabled: true` into it would still change the file -- which is a real edit, not this
    // case, and asserting the two are different is the point of writing them out here.)
    const { path, config } = await configFile({
      laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"], enabled: true },
      julia: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"], enabled: false },
    })
    const result = await switchToBackend(path, config, "laya")
    expect(result.changed).toBe(false)
    expect(result.on).toEqual(["laya"])
  })

  test("a backend that is not in the config is refused, and the message says what is", async () => {
    // This is the branch the TUI's warning toast reports. It has to be a real answer rather
    // than a generic failure, because the whole point of the toast is telling someone why
    // the second half did not happen.
    const { path, config } = await configFile({
      laya: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["predict"] },
    })
    await expect(switchToBackend(path, config, "julia")).rejects.toThrow(
      /no backend named "julia".*found: laya/s,
    )
  })
})
