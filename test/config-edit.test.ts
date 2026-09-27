/**
 * Editing the config without losing it.
 *
 * The config is JSONC and every number in it has a comment explaining why it is that
 * number. Those comments are the reason the file is hand-editable, so a command that
 * rewrites it through `JSON.stringify` is a command that deletes the file's value. These
 * tests pin the round trip.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { editConfig, setEnabled } from "../src/config-edit.ts"
import { validate } from "../src/config.ts"
import { parse } from "jsonc-parser"

const parseJsonc = (text: string) => parse(text) as unknown

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

const SAMPLE = `{
  // High enough to be unlikely to collide with anything else.
  "port": 7331,

  /* wind down after this long */
  "idleShutdownSecs": 600,

  "backends": {
    "laya": {
      "transport": "stdio-mcp",
      "command": ["x"],
      // keep this, it is the whole point
      "toolPrefix": "laya_"
    },
    "julia": {
      "transport": "stdio-mcp",
      "command": ["y"],
      "enabled": false
    }
  }
}
`

describe("switching models", () => {
  test("comments survive an edit", () => {
    const out = setEnabled(SAMPLE, "laya", true)
    expect(out).toContain("// High enough to be unlikely to collide")
    expect(out).toContain("/* wind down after this long */")
    expect(out).toContain("// keep this, it is the whole point")
  })

  test("unrelated fields are untouched", () => {
    const out = setEnabled(SAMPLE, "laya", false)
    expect(out).toContain('"port": 7331')
    expect(out).toContain('"idleShutdownSecs": 600')
    expect(out).toContain('"command": ["y"]')
  })

  test("the result is still a config the daemon will accept", () => {
    // The real test of an editor that splices text: not "did the string change" but "does
    // the thing that consumes it still work.
    const out = setEnabled(SAMPLE, "laya", false)
    expect(() => validate(parseJsonc(out), "test")).not.toThrow()
  })

  test("an existing false becomes true", () => {
    const out = setEnabled(SAMPLE, "julia", true)
    expect(validate(parseJsonc(out), "test").backends.julia!.enabled).toBe(true)
  })

  test("naming a backend that does not exist lists the ones that do", () => {
    expect(() => setEnabled(SAMPLE, "nope", true)).toThrow(/laya, julia/)
  })

  test("a config that is not valid JSONC is refused, not mangled", () => {
    expect(() => setEnabled('{ "port": ', "laya", true)).toThrow(/not valid JSONC/)
  })
})

describe("writing", () => {
  test("an unchanged edit does not write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-edit-"))
    dirs.push(dir)
    const path = join(dir, "onesystem.json")
    await writeFile(path, SAMPLE)

    // Already false, so setting false is a no-op.
    const result = await editConfig(path, (text) => setEnabled(text, "julia", false))
    expect(result.changed).toBe(false)
  })

  test("a change is written and the comments are still there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-edit-"))
    dirs.push(dir)
    const path = join(dir, "onesystem.json")
    await writeFile(path, SAMPLE)

    const result = await editConfig(path, (text) => setEnabled(text, "julia", true))
    expect(result.changed).toBe(true)
    const onDisk = await readFile(path, "utf8")
    expect(onDisk).toContain("// keep this, it is the whole point")
  })
})
