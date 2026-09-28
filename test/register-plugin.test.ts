/**
 * Registering the plugin: a directory of re-exports under OpenCode's plugins dir, and no
 * edit to any config. `opencode plugin list` shows the server half; the TUI half is the
 * status line, which that command does not report.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, basename, dirname } from "node:path"
import { pluginAutoloadFiles } from "../src/config-edit.ts"

const src = (...p: string[]) => join(import.meta.dir, "..", ...p)
const names = (dir: string, files: { path: string }[]) =>
  files.map((f) => f.path.slice(dir.length + 1)).sort()

/** Run `body` with OPENCODE_CONFIG_DIR set, so nothing touches the real config dir. */
async function withConfigDir<T>(path: string | undefined, body: () => T): Promise<T> {
  const previous = process.env.OPENCODE_CONFIG_DIR
  if (path === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = path
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
  }
}

describe("the autoload files", () => {
  test("one entrypoint per half, as siblings", () => {
    // A lone `onesystem.ts` loads the server plugin and silently drops the TUI one.
    const { dir, files } = pluginAutoloadFiles()
    expect(names(dir, files)).toEqual(["onesystem-index.ts", "onesystem-tui.ts"])
  })

  test("each re-exports the entrypoint of the same name", () => {
    const { files } = pluginAutoloadFiles()
    for (const f of files) {
      // The file is prefixed so it cannot collide with another plugin's `index.ts` in the
      // shared directory; the entrypoint it re-exports is the unprefixed name.
      const name = basename(f.path).replace(/^onesystem-/, "")
      expect(f.contents.trim().endsWith(`/src/plugin/${name}"`)).toBe(true)
    }
  })

  test("both resolve to a plugin with hooks", async () => {
    const { files } = pluginAutoloadFiles()
    for (const f of files) {
      const mod = await import(f.contents.match(/from "(.*)"/)![1]!)
      expect(typeof mod.default?.setup).toBe("function")
    }
  })

  test("repeated runs are byte-identical, so a re-run trips no watcher", () => {
    const once = pluginAutoloadFiles().files.map((f) => f.contents)
    expect(pluginAutoloadFiles().files.map((f) => f.contents)).toEqual(once)
  })

  test("the entrypoints resolve outside their own directory, so a copy would not run", async () => {
    // Rules out copying `src/plugin/` into the plugins dir. A copy of the whole tree would
    // run, and would be a second copy of the code the plugin executes, stale after a pull.
    const discover = await readFile(src("src", "plugin", "discover.ts"), "utf8")
    const index = await readFile(src("src", "plugin", "index.ts"), "utf8")
    expect(discover).toContain('new URL("../cli.ts", import.meta.url)')
    expect(index).toMatch(/from "\.\.\//)
  })
})

describe("where the files land", () => {
  test("directly in OPENCODE_CONFIG_DIR/plugins, not a subdirectory", async () => {
    // OpenCode's auto-discovery is not recursive: it reads the `*.ts` and `*.js` files in
    // the plugins dir itself. A nested `plugins/onesystem/index.ts` is never loaded, and
    // nothing says so -- the install reports success and the tools simply never appear.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-oc-"))
    const { dir: target, files } = await withConfigDir(dir, pluginAutoloadFiles)
    expect(target).toBe(join(dir, "plugins"))
    for (const f of files) {
      expect(dirname(f.path)).toBe(target)
      expect(basename(f.path)).toMatch(/\.ts$/)
    }
  })

  test("the default is ~/.config/opencode/plugins, not onesystem's own share dir", async () => {
    const { dir } = await withConfigDir(undefined, pluginAutoloadFiles)
    expect(dir).toMatch(/\/\.config\/opencode\/plugins$/)
  })
})

describe("the user's OpenCode config", () => {
  test("no exported function can be handed a config path", async () => {
    const source = await readFile(src("src", "config-edit.ts"), "utf8")
    const exported = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!)
    expect(exported).not.toContain("opencodeConfigPath")
  })

  test("the command only writes the entrypoints it was given", async () => {
    const cli = await readFile(src("src", "cli.ts"), "utf8")
    const body = cli.slice(cli.indexOf("async function cmdRegisterPlugin"))
    const code = body.slice(0, body.indexOf("\n}\n")).replace(/\/\/[^\n]*/g, "")
    expect(code).not.toContain("opencode.json")
    expect([...code.matchAll(/writeFile\(([^,]+),/g)].map((m) => m[1]!.trim())).toEqual(["f.path"])
  })

  test("a plugins array of the user's own survives registration", async () => {
    const config = `{\n  // mine\n  "plugins": [{ "package": "some-other-plugin" }]\n}\n`
    const ocDir = await mkdtemp(join(tmpdir(), "onesystem-oc-"))
    const path = join(ocDir, "opencode.json")
    await writeFile(path, config)

    const { dir, files } = await withConfigDir(ocDir, pluginAutoloadFiles)
    await mkdir(dir, { recursive: true })
    for (const f of files) await writeFile(f.path, f.contents)

    expect((await readdir(dir)).sort()).toEqual(["onesystem-index.ts", "onesystem-tui.ts"])
    expect(await readFile(path, "utf8")).toBe(config)
  })
})
