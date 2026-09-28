/**
 * Registering the plugin into `opencode.json`, which a person hand-edits.
 *
 * This is the one install step a shell script cannot do on its own. `opencode.json` is
 * JSONC with comments in it, so the options from bash are a `sed` against a layout nobody
 * controls, or a `JSON.parse` round trip that deletes every comment and every key the
 * script did not know about. Both were real: the file this reads has comments in it and
 * keys an installer has no business touching.
 */

import { describe, expect, test } from "bun:test"
import { registerPlugin } from "../src/config-edit.ts"

const DIR = "/home/you/onesystem/src/plugin"

/** Shaped like a real one: comments, and keys an installer has no business touching. */
const SAMPLE = `{
  // the agent config
  "model": "anthropic/claude-sonnet-4",
  "theme": "tokyonight",
  "permission": {
    // allow the boring ones
    "edit": "allow"
  },
  "mcp": {
    "servers": { "chrome-devtools": { "type": "local" } }
  }
}
`

const parse = (t: string) => JSON.parse(t.replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>

describe("registering the plugin", () => {
  test("it adds the entry to a config that has none", () => {
    const { text, added, alreadyThere } = registerPlugin(SAMPLE, DIR)
    expect(added).toBe(true)
    expect(alreadyThere).toBe(false)
    expect(parse(text).plugins).toEqual([{ package: DIR }])
  })

  test("comments and unrelated keys survive", () => {
    // The reason this is code and not `sed`. A `JSON.parse`/`stringify` round trip is
    // shorter by a few lines and destroys every comment in the file.
    const { text } = registerPlugin(SAMPLE, DIR)
    expect(text).toContain("// the agent config")
    expect(text).toContain("// allow the boring ones")
    const before = parse(SAMPLE)
    const after = parse(text)
    for (const key of Object.keys(before)) {
      expect(`${key}: ${JSON.stringify(after[key])}`).toBe(`${key}: ${JSON.stringify(before[key])}`)
    }
  })

  test("it is idempotent", () => {
    // The install script is re-runnable, and a second entry for the same path makes
    // opencode load the plugin twice.
    const once = registerPlugin(SAMPLE, DIR)
    const twice = registerPlugin(once.text, DIR)
    expect(twice.added).toBe(false)
    expect(twice.alreadyThere).toBe(true)
    expect(twice.text).toBe(once.text)
    expect(parse(twice.text).plugins).toHaveLength(1)
  })

  test("it recognises a path written with a trailing slash or a dot segment", () => {
    // `package` is a directory, and a person may have written it either way. Comparing
    // bytes would re-add the entry and load the plugin twice for no reason.
    for (const variant of [`${DIR}/`, `${DIR}/.`, `${DIR}/./`]) {
      const seeded = registerPlugin(SAMPLE, DIR)
      const { text } = registerPlugin(seeded.text.replace(DIR, variant), DIR)
      expect(`${variant}: ${parse(text).plugins.length}`).toBe(`${variant}: 1`)
    }
  })

  test("it keeps other plugins and appends after them", () => {
    const withOther = registerPlugin(SAMPLE, DIR)
    const second = registerPlugin(
      withOther.text.replace(DIR, "/other/plugin/src/plugin"),
      DIR,
    )
    expect(parse(second.text).plugins.map((p: any) => p.package)).toEqual([
      "/other/plugin/src/plugin",
      DIR,
    ])
  })

  test("a plugins value that is not an array is refused, not overwritten", () => {
    // Somebody's deliberate shape. Guessing at it is how an install eats a config.
    const odd = `{\n  // mine\n  "plugins": { "package": "/mine" }\n}\n`
    expect(() => registerPlugin(odd, DIR)).toThrow(/not an array/)
  })

  test("an empty or absent file is seeded rather than refused", () => {
    for (const empty of ["", "   \n"]) {
      const { text, added } = registerPlugin(empty, DIR)
      expect(added).toBe(true)
      expect(parse(text)).toEqual({ plugins: [{ package: DIR }] })
    }
  })

  test("a file that is not JSONC is refused, and says where", () => {
    // The error has to name the file, because the caller may be pointed at opencode's
    // config by a script the person is running rather than typing.
    expect(() => registerPlugin('{ "plugins": [ }', DIR)).toThrow(/not valid JSONC at offset/)
  })
})
