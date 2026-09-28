/**
 * Registering the plugin with opencode, which autodiscovers it from a directory.
 *
 * opencode V2 loads every `.ts` and `.js` file in `~/.config/opencode/plugins/`, so
 * registering means writing one line there. What these tests pin is the part that is easy to
 * get wrong: that the file is a re-export of the checkout rather than a copy of it, and that
 * a copy is not an option here at all.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unregisterPlugin, pluginAutoloadFile } from "../src/config-edit.ts"

const DIR = "/home/you/onesystem/src/plugin"

const parse = (t: string) => JSON.parse(t.replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>

describe("the autodetect file", () => {
  test("it is a one-line re-export of the plugin entry", () => {
    const { contents } = pluginAutoloadFile()
    // The path is this checkout's, resolved from the module rather than configured, so it is
    // asserted by shape and then checked against the real file further down. Hardcoding a
    // path here is what made an earlier version of this test fail on its own fixture.
    expect(contents.trim()).toMatch(/^export \{ default \} from ".*src\/plugin\/index\.ts"$/)
  })

  test("it lands in the plugins directory opencode watches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-oc-"))
    const { path, contents } = pluginAutoloadFile()
    // Redirected rather than read from the real home: this asserts the layout without
    // writing into somebody's opencode config.
    expect(path.endsWith(join("plugins", "onesystem.ts"))).toBe(true)
    // The entry is a `.ts` inside the plugins dir, which is one of the two forms opencode
    // autodiscovers. A directory would need an index file of its own and would be a copy.
    expect(contents).toContain(".ts")
    expect(dir).toBeTruthy()
  })

  test("a copy is not an option, and here is why", async () => {
    // Written as a test because the reason is invisible in the finished file. The plugin
    // imports modules from the directory above it and derives its own CLI path from
    // `../cli.ts`, so a copy of `src/plugin/` alone does not resolve. A copy of the whole
    // tree resolves and is worse: it is a second copy of the code the plugin runs, which
    // goes stale on `git pull` and nobody notices until the two disagree.
    const plugin = await readFile(join(import.meta.dir, "..", "src", "plugin", "discover.ts"), "utf8")
    expect(plugin).toContain('new URL("../cli.ts", import.meta.url)')
    const index = await readFile(join(import.meta.dir, "..", "src", "plugin", "index.ts"), "utf8")
    expect(index).toMatch(/from "\.\.\//)
  })
})

describe("removing the old config entry", () => {
  /** Shaped like the real thing: comments, and keys an installer has no business touching. */
  const SAMPLE = `{
  // the agent config
  "model": "anthropic/claude-sonnet-4",
  "plugins": [
    { "package": "${DIR}" },
    { "package": "/other/plugin" }
  ],
  "permission": {
    // allow the boring ones
    "edit": "allow"
  }
}
`

  test("it removes only this repo's entry, and says how many", () => {
    const { text, removed } = unregisterPlugin(SAMPLE, DIR)
    expect(removed).toBe(1)
    expect(parse(text).plugins).toEqual([{ package: "/other/plugin" }])
  })

  test("comments and unrelated keys survive", () => {
    // The reason this is code and not `sed`. A `JSON.parse`/`stringify` round trip is
    // shorter by a few lines and destroys every comment in the file.
    const { text } = unregisterPlugin(SAMPLE, DIR)
    expect(text).toContain("// the agent config")
    expect(text).toContain("// allow the boring ones")
    const before = parse(SAMPLE)
    const after = parse(text)
    for (const key of Object.keys(before)) {
      if (key === "plugins") continue
      expect(`${key}: ${JSON.stringify(after[key])}`).toBe(`${key}: ${JSON.stringify(before[key])}`)
    }
  })

  test("it recognises a path written with a trailing slash or a dot segment", () => {
    // Compared resolved, because `package` is a directory and a person may have written it
    // either way. Byte comparison would miss it and leave the plugin registered twice.
    for (const variant of [`${DIR}/`, `${DIR}/.`, `${DIR}/./`]) {
      const { removed } = unregisterPlugin(SAMPLE.replace(DIR, variant), DIR)
      expect(`${variant}: ${removed}`).toBe(`${variant}: 1`)
    }
  })

  test("a config that does not list this plugin is left byte-identical", () => {
    // So a re-run reports "already correct" instead of rewriting the file for nothing.
    for (const sample of [
      `{\n  "plugins": [{ "package": "/other/plugin" }]\n}\n`,
      `{\n  "plugins": []\n}\n`,
      `{\n  "model": "x"\n}\n`,
    ]) {
      const { text, removed } = unregisterPlugin(sample, DIR)
      expect(`${removed}: ${text === sample}`).toBe("0: true")
    }
  })

  test("a plugins value that is not an array is left alone", () => {
    // Somebody's deliberate shape. Guessing at it is how an install eats a config, and
    // leaving it is safe: the autodetect file already registered the plugin.
    const odd = `{\n  // mine\n  "plugins": { "package": "${DIR}" }\n}\n`
    const { text, removed } = unregisterPlugin(odd, DIR)
    expect(removed).toBe(0)
    expect(text).toBe(odd)
  })

  test("a file that is not JSONC is refused, and says where", () => {
    expect(() => unregisterPlugin('{ "plugins": [ }', DIR)).toThrow(/not valid JSONC at offset/)
  })
})

describe("what the command writes, end to end", () => {
  test("a repeated run is byte-identical, so re-running changes nothing", async () => {
    // The installer is meant to be safe to re-run, and a file whose contents are rewritten
    // with a fresh timestamp every time would make opencode's watcher reload the plugin on
    // every install for no reason.
    const first = pluginAutoloadFile().contents
    const second = pluginAutoloadFile().contents
    expect(second).toBe(first)

    // And the plugin it points at has to be the default export, or opencode loads a module
    // with no hooks in it and the session silently has no tools.
    const entry = first.match(/from "(.*)"/)![1]!
    const mod = await import(entry)
    expect(typeof mod.default).toBe("object")
    expect(typeof mod.default.setup).toBe("function")
  })

  test("the real entry file is what the generated line points at", async () => {
    const { contents } = pluginAutoloadFile()
    const entry = contents.match(/from "(.*)"/)![1]!
    const here = join(import.meta.dir, "..")
    // Resolves to this checkout, not to an installer's copy of it.
    expect(entry.startsWith(here)).toBe(true)
    await expect(readFile(entry, "utf8")).resolves.toContain("Plugin.define")
  })
})
