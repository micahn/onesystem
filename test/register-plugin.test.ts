/**
 * Registering the plugin with OpenCode, which autodiscovers it from a directory.
 *
 * Two things are pinned here. That the registration is a directory with one entrypoint per
 * half, because a TUI entrypoint is only found beside the server one. And that nothing reads
 * or writes `opencode.json`: an installer that edits a config it does not own goes wrong on
 * somebody else's machine, and this registration needs no config at all.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pluginAutoloadFiles } from "../src/config-edit.ts"

const parse = (t: string) => JSON.parse(t.replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>

describe("the autoload files", () => {
  test("it writes a directory, with one entrypoint per half", async () => {
    const { dir, files } = pluginAutoloadFiles()
    expect(dir.endsWith(join("plugins", "onesystem"))).toBe(true)
    // Both halves, and they are siblings. A single `onesystem.ts` loads the server plugin
    // and silently drops the TUI one, which looks like a working install with no footer.
    expect(files.map((f) => f.path.slice(dir.length + 1)).sort()).toEqual(["index.ts", "tui.ts"])
  })

  test("each one re-exports the matching checkout entrypoint", () => {
    const { files } = pluginAutoloadFiles()
    // Matched by suffix rather than a built regex: `tui.ts` has to point at `tui.ts`, and
    // pairing the wrong halves would load a TUI that renders the server's state.
    for (const f of files) {
      const name = f.path.slice(f.path.lastIndexOf("/") + 1)
      expect(f.contents.trim().endsWith(`/src/plugin/${name}"`)).toBe(true)
    }
  })

  test("a copy is not an option, and here is why", async () => {
    // Written as a test because the reason is invisible in the finished files. The plugin
    // imports modules from the directory above it and resolves its own CLI at `../cli.ts`,
    // so a copy of `src/plugin/` alone does not run. A copy of the whole tree does, and is
    // worse: a second copy of the code the plugin executes, which goes stale on `git pull`
    // and nobody notices until the two disagree.
    const discover = await readFile(join(import.meta.dir, "..", "src", "plugin", "discover.ts"), "utf8")
    expect(discover).toContain('new URL("../cli.ts", import.meta.url)')
    const index = await readFile(join(import.meta.dir, "..", "src", "plugin", "index.ts"), "utf8")
    expect(index).toMatch(/from "\.\.\//)
  })

  test("both entrypoints resolve to the real plugin objects", async () => {
    // The point of the exercise: a re-export that resolves to a module with no hooks in it
    // is a plugin that loads and does nothing.
    const { files } = pluginAutoloadFiles()
    for (const f of files) {
      const mod = await import(f.contents.match(/from "(.*)"/)![1]!)
      expect(`${f.path}: ${typeof mod.default}`).toBe(`${f.path}: object`)
      expect(`${f.path}: ${typeof mod.default.setup}`).toBe(`${f.path}: function`)
    }
  })

  test("a repeated run produces byte-identical files", () => {
    // So re-running the installer does not make OpenCode's watcher reload the plugin for
    // no reason.
    const a = pluginAutoloadFiles().files.map((f) => f.contents)
    const b = pluginAutoloadFiles().files.map((f) => f.contents)
    expect(b).toEqual(a)
  })
})

describe("the user's OpenCode config", () => {
  test("registration never reads or writes opencode.json", async () => {
    // The strongest form of the claim. `pluginAutoloadFiles` resolves its own target from
    // the environment and the module's own location, so a caller cannot be handed a config
    // path to edit, and no exported function takes one.
    const source = await readFile(join(import.meta.dir, "..", "src", "config-edit.ts"), "utf8")
    const exported = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]!)
    // `opencodeConfigPath` was the only way to reach the file, and it is gone.
    expect(exported).not.toContain("opencodeConfigPath")
    expect(source).not.toContain("unregisterPlugin")

    const cli = await readFile(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    // Comments are stripped before the check, because the command carries a comment naming
    // `opencode.json` to explain why it does not go near it. Matching on raw text failed on
    // that comment, which is the note working, not the guard failing.
    const body = cli
      .slice(cli.indexOf("async function cmdRegisterPlugin"))
      .slice(0, cli.slice(cli.indexOf("async function cmdRegisterPlugin")).indexOf("\n}\n"))
      .replace(/\/\/[^\n]*/g, "")
    expect(body).not.toContain("opencode.json")
    // And every write it performs targets a path the autoload files own.
    expect([...body.matchAll(/writeFile\(([^,]+),/g)].map((m) => m[1]!.trim())).toEqual(["f.path"])
  })

  test("the directory lands where OpenCode watches, and a config file is irrelevant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-oc-"))
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = dir
    try {
      const { dir: target, files } = pluginAutoloadFiles()
      // `OPENCODE_CONFIG_DIR` is the config directory, and a discovered plugin lives at
      // `<config-dir>/plugins/onesystem/`. Writing to `<config-dir>/onesystem/` instead
      // puts the files somewhere opencode does not look, which is a silent no-op install.
      expect(target).toBe(join(dir, "plugins", "onesystem"))
      // Nothing else is consulted: no config, no registry, no network.
      expect(files.every((f) => f.contents.startsWith("export { default } from"))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
    }
  })

  test("the default location is the OpenCode plugins directory", () => {
    const previous = process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    try {
      // Not `~/.local/share`, which is where onesystem's own runtimes live and where a
      // plugin placed there is not discovered at all.
      const { dir } = pluginAutoloadFiles()
      expect(dir).toMatch(/\/\.config\/opencode\/plugins\/onesystem$/)
      expect(dir).not.toContain(".local/share")
    } finally {
      if (previous !== undefined) process.env.OPENCODE_CONFIG_DIR = previous
    }
  })

  test("a plugins array someone else owns is not ours to touch", async () => {
    // The scenario the old code got wrong: a user with their own `plugins` array. Writing to
    // it to remove our own entry is a correct-looking edit to a file we do not own.
    const mine = `{\n  // my plugins\n  "plugins": [{ "package": "some-other-plugin" }]\n}\n`
    const ocDir = await mkdtemp(join(tmpdir(), "onesystem-oc-"))
    const config = join(ocDir, "opencode.json")
    await writeFile(config, mine)

    // The config file sits beside the plugins directory, which is where a user's own
    // `plugins` array would be. Registration writes only under `plugins/` and leaves it.
    const previous = process.env.OPENCODE_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = ocDir
    try {
      const { dir, files } = pluginAutoloadFiles()
      await mkdir(dir, { recursive: true })
      for (const f of files) await writeFile(f.path, f.contents)
      expect((await readdir(dir)).sort()).toEqual(["index.ts", "tui.ts"])
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
    }

    expect(await readFile(config, "utf8")).toBe(mine)
  })
})
