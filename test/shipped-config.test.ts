/**
 * Every environment variable in the template must be read by its backend.
 * The supervisor owns idle shutdown and request timeouts; shims must not imply
 * that unused variables enforce either policy.
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { validate } from "../src/config.ts"

const repo = join(import.meta.dir, "..")
const shipped = join(repo, "onesystem.config.jsonc")

const readShipped = async () => validate(parse(await readFile(shipped, "utf8")) as object, shipped)

/** Every `NAME` the shipped config's backend `env` blocks set. */
async function configuredEnv(): Promise<Record<string, string[]>> {
  const doc = parse(await readFile(shipped, "utf8")) as {
    backends: Record<string, { env?: Record<string, string>; command?: string[] }>
  }
  const out: Record<string, string[]> = {}
  for (const [backend, spec] of Object.entries(doc.backends)) {
    out[backend] = Object.keys(spec.env ?? {})
  }
  return out
}

/** The file a backend's `command` actually runs, when it points into this repo. */
async function shimFor(backend: string): Promise<string | null> {
  const doc = parse(await readFile(shipped, "utf8")) as {
    backends: Record<string, { command?: string[] }>
  }
  const cmd = doc.backends[backend]?.command ?? []
  const inRepo = cmd.find((a) => a.includes("/src/shims/"))
  return inRepo ? join(repo, inRepo.replace(/^\/path\/to\/onesystem\//, "")) : null
}

describe("the shipped config", () => {
  test("it validates", async () => {
    // Everything else here is worthless if the file does not load, and the edits that fixed
    // the paths below were made to a JSONC file by hand.
    await expect(readShipped()).resolves.toBeDefined()
  })

  test("every env var it sets for julia is one the julia shim reads", async () => {
    const env = (await configuredEnv()).julia ?? []
    const shim = await shimFor("julia")
    expect(shim).not.toBeNull()
    const source = await readFile(shim!, "utf8")

    for (const name of env) {
      // `os.environ.get("NAME"` or `os.getenv("NAME"` -- an actual read, not a mention in a
      // comment or a docstring. A variable that only appears in prose is exactly the failure
      // this test exists to catch, so the match has to be a call.
      const read = new RegExp(`os\\.(environ\\.get|getenv)\\(\\s*["']${name}["']`)
      expect(`${name}: ${read.test(source)}`).toBe(`${name}: true`)
    }
  })

  test("the julia backend sets no variable the shim does not read", async () => {
    // The two that used to be here, named explicitly so a failure says which.
    const env = (await configuredEnv()).julia ?? []
    expect(env).not.toContain("JULIA_IDLE_UNLOAD_SECS")
    expect(env).not.toContain("JULIA_TOOL_TIMEOUT_SECS")
  })

  test("laya's env carries only settings laya itself reads", async () => {
    // `LAYA_IDLE_UNLOAD_SECS` and `LAYA_TOOL_TIMEOUT_SECS` used to be here, for a shim that
    // implemented an idle-unload watchdog and a per-call timeout. Both are the daemon's job
    // now: it quiesces a backend by closing the process, which releases every checkpoint,
    // and it layers `requestTimeoutSecs` over the forward. The variables are gone from the
    // template because the thing that read them no longer runs.
    //
    // What is pinned now is the general rule: every variable the template sets must be one
    // laya's own server reads. A variable nothing reads asserts a relationship that does
    // not exist, which is the same failure this file was written for.
    const env = (await configuredEnv()).laya ?? []
    expect(env).not.toContain("LAYA_IDLE_UNLOAD_SECS")
    expect(env).not.toContain("LAYA_TOOL_TIMEOUT_SECS")
    // The two that are load-bearing: the device, and lazy loading. `LAYA_PRELOAD: "0"` is
    // what keeps the checkpoint out of VRAM until a request asks for it.
    expect(env).toContain("LAYA_DEVICE")
    expect(env).toContain("LAYA_PRELOAD")
  })

  test("a runtime path points at where the installer actually writes", async () => {
    // `install.ts` puts runtimes under `$ONESYSTEM_DATA_DIR/runtimes`, defaulting to
    // `~/.local/share/onesystem`. The shipped file pointed at `<repo>/runtimes/...`, which
    // the installer never writes to -- so following the file's own header ("run
    // `onesystem install`, it prints the snippet") and then using the shipped path gave you
    // a command that spawns a process which does not exist.
    const text = await readFile(shipped, "utf8")
    expect(text).not.toContain("/path/to/onesystem/runtimes/")
    expect(text).toContain(".local/share/onesystem/runtimes/")
  })

  test("the config never claims the daemon's cap is the shim's", async () => {
    // The comment used to say `requestTimeoutSecs` "Matches LAYA_TOOL_TIMEOUT_SECS in the
    // shim". Two numbers that happen to both be 120 is not a match, and the comment invited
    // someone to change one and not the other.
    //
    // Only the half that catches a false claim is left. This used to also require a
    // particular sentence introducing the key, which meant the config had to carry
    // explanatory prose forever; a minimal file is allowed to say less, as long as what it
    // does say is not wrong.
    const text = await readFile(shipped, "utf8")
    expect(text).not.toMatch(/Matches LAYA_TOOL_TIMEOUT_SECS/)
  })
})

describe("the julia shim", () => {
  const shimPath = join(repo, "src", "shims", "julia-mcp.py")

  test("it has no unused module-level constants left", async () => {
    // The general version of the specific bug. `IDLE_UNLOAD_SECS` and `TOOL_TIMEOUT_SECS`
    // were both assigned at module scope and read nowhere; a shim is small enough that a
    // read can be counted rather than argued about.
    const source = await readFile(shimPath, "utf8")
    const assigned = [...source.matchAll(/^([A-Z_]{3,})\s*=/gm)].map((m) => m[1]!)
    expect(assigned.length).toBeGreaterThan(0)
    for (const name of assigned) {
      // At least one use beyond the assignment. Not exactly one: `CHECKPOINT` is read twice
      // (guarded, then passed), and requiring a precise count would make this test a
      // refactoring hazard rather than a dead-code check.
      const uses = [...source.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length
      expect(`${name}: ${uses} mentions`).toSatisfy((msg: string) => !/: [01] /.test(msg))
    }
  })

  test("it imports nothing it does not use", async () => {
    // `import json` and `import time` were both dead. `time` went with the idle reaper;
    // `json` had been unused since the file was written.
    const source = await readFile(shimPath, "utf8")
    const imported = [...source.matchAll(/^import (\w+)$/gm)].map((m) => m[1]!)
    expect(imported.length).toBeGreaterThan(0)
    for (const mod of imported) {
      const used = new RegExp(`\\b${mod}\\.`).test(source)
      expect(`${mod}: imported and used=${used}`).toBe(`${mod}: imported and used=true`)
    }
  })

  test("it names where the idle window and the per-call cap actually live", async () => {
    // A maintainer opening this file during a hang needs to be told where to look, and the
    // old docstring said "everything worth sharing ... already exists on the daemon side"
    // and then implemented two dead versions of two of them.
    const source = await readFile(shimPath, "utf8")
    expect(source).toMatch(/supervisor\.ts/)
    expect(source).toMatch(/requestTimeoutSecs/)
  })
})
