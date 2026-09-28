/**
 * Config edits must preserve JSONC comments and unrelated settings.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
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
      "tools": ["predict", "status"],
      // keep this, it is the whole point
      "toolPrefix": "laya_"
    },
    "julia": {
      "transport": "stdio-mcp",
      "command": ["y"],
      "tools": ["predict"],
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

  test("it refuses rather than clobbering a file that changed underneath it", async () => {
    // The invariant that justifies re-reading before writing: a person may have edited the
    // file between our read and our write, and silently reverting their change because we
    // held a stale copy is worse than refusing.
    //
    // The window is one microtask wide -- read, mutate, re-read, compare, write -- so the
    // only way to hit it deterministically is to perform the concurrent edit from *inside*
    // `mutate`, which is precisely where a real one would land. Racing a `writeFile` against
    // the call from a test is a coin flip, and a coin-flip test is worse than no test.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-edit-"))
    dirs.push(dir)
    const path = join(dir, "onesystem.json")
    await writeFile(path, SAMPLE)

    await expect(
      editConfig(path, (text) => {
        writeFileSync(path, `${text}\n// edited by someone else, mid-command\n`)
        return setEnabled(text, "julia", true)
      }),
    ).rejects.toThrow(/changed while this command was running/)

    // And the other person's edit is what is on disk. Refusing has to mean refusing.
    const onDisk = await readFile(path, "utf8")
    expect(onDisk).toContain("edited by someone else, mid-command")
  })
})
