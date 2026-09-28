/**
 * The shipped config only sets environment variables that exist.
 *
 * `onesystem.config.jsonc` is the first thing a person copies, and it is the file they edit
 * when something hangs. So a variable in it that nothing reads is worse than a missing one:
 * it asserts a relationship that does not exist, and it is asserted in three places at once.
 *
 * That is not hypothetical. The shipped config set `JULIA_IDLE_UNLOAD_SECS` and
 * `JULIA_TOOL_TIMEOUT_SECS`, and a comment claimed the config's `requestTimeoutSecs`
 * "matches LAYA_TOOL_TIMEOUT_SECS in the shim". The julia shim read both variables into
 * module-level constants and then never used either: `TOOL_TIMEOUT_SECS` was assigned and
 * read nowhere in the file, and the `reap_if_idle` that was supposed to consume
 * `IDLE_UNLOAD_SECS` was defined and invoked nowhere in its 101 lines. Three places
 * asserting that a child enforces a per-call cap that no child enforced -- while the daemon
 * enforced it correctly, at `supervisor.ts`, which is the only place that ever did.
 *
 * The dead code is gone. This test is what keeps it gone, and it is the general form rather
 * than a one-off: it reads the shipped config, finds every variable it sets, and checks each
 * one against the source of the shim that backend actually spawns.
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

  test("the laya backend's variables are the shim's own business, and are left alone", async () => {
    // laya's idle window and tool timeout are real: its shim implements both. So this is a
    // deliberate non-assertion rather than an oversight -- the point of the ticket was dead
    // code in *julia's* shim, and "make them all the same" would have been the wrong fix.
    // What is pinned is that the julia shim's removal did not quietly become a change to
    // laya's variables.
    const env = (await configuredEnv()).laya ?? []
    expect(env).toContain("LAYA_IDLE_UNLOAD_SECS")
    expect(env).toContain("LAYA_TOOL_TIMEOUT_SECS")
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
