/**
 * Reading a config without refusing to return it.
 *
 * The property under test is a command's ability to run when the config is wrong.
 * `loadConfig` refusing is deliberate -- a wrong setting should be an error, not
 * something to work around -- but it means the command you need in that situation has
 * to reach the file another way. `doctor` is how you find out what is wrong, and `stop`
 * has to keep working, or you are locked out of both.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, probeConfig, validate, type Config } from "../src/config.ts"
import { repairConfig } from "../src/config-edit.ts"

/** The contradiction #18 introduced, as `install` used to write it. */
const CONTRADICTORY = (extra = ""): string =>
  `{
  // hand written
  "port": 7399,${extra}
  "requestTimeoutSecs": 120,
  "backends": {
    "laya": {
      "transport": "stdio-mcp",
      "command": ["/bin/true"],
      "tools": ["predict"],
      "startupTimeoutSecs": 180
    }
  }
}`

async function withConfig<T>(text: string, body: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-probe-"))
  const path = join(dir, "onesystem.jsonc")
  await writeFile(path, text)
  const previous = process.env.ONESYSTEM_CONFIG_DIR
  process.env.ONESYSTEM_CONFIG_DIR = dir
  try {
    return await body(path)
  } finally {
    if (previous === undefined) delete process.env.ONESYSTEM_CONFIG_DIR
    else process.env.ONESYSTEM_CONFIG_DIR = previous
  }
}

describe("a config that cannot be loaded", () => {
  test("doctor can still read it, and is told what is wrong", async () => {
    await withConfig(CONTRADICTORY(), async () => {
      const probe = await probeConfig()
      expect(probe.config).toBeUndefined()
      expect(probe.problems).toHaveLength(1)
      expect(probe.problems[0]!.message).toMatch(/startupTimeoutSecs \(180\) exceeds requestTimeoutSecs \(120\)/)
    })
  })

  test("the problem carries its own repair, not a sentence to re-read", async () => {
    // The fix is computed where the rule lives and carried on the error, so rewording the
    // message cannot silently stop offering it. A regex over the wording would.
    await withConfig(CONTRADICTORY(), async () => {
      const { problems } = await probeConfig()
      expect(problems[0]!.fix).toEqual({ key: "requestTimeoutSecs", value: 180 })
    })
  })

  test("stop can still find the address, because a broken backend is not a broken address", async () => {
    // The port has to come from the file that is wrong, not from the defaults: stopping
    // the daemon on the wrong port leaves it running.
    await withConfig(CONTRADICTORY(), async () => {
      const { address, problems } = await probeConfig()
      expect(problems).toHaveLength(1)
      expect(address).toEqual({ host: "127.0.0.1", port: 7399 })
    })
  })

  test("an address it cannot trust falls back rather than being used", async () => {
    // A routable host would be a config error, and a daemon on it is not one to signal.
    const text = CONTRADICTORY('\n  "host": "0.0.0.0",')
    await withConfig(text, async () => {
      const { address } = await probeConfig()
      expect(address).toEqual({ host: "127.0.0.1", port: 7399 })
    })
  })

  test("a missing file is a problem, not a crash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-probe-"))
    const previous = process.env.ONESYSTEM_CONFIG_DIR
    process.env.ONESYSTEM_CONFIG_DIR = dir
    try {
      const probe = await probeConfig()
      expect(probe.problems[0]!.message).toContain("no config at")
      expect(probe.problems[0]!.fix).toBeUndefined()
      expect(probe.address.port).toBe(7331)
    } finally {
      if (previous === undefined) delete process.env.ONESYSTEM_CONFIG_DIR
      else process.env.ONESYSTEM_CONFIG_DIR = previous
    }
  })

  test("a file that is not JSONC is reported as such, with no repair offered", async () => {
    await withConfig('{ "port": 7331, ', async () => {
      const { problems } = await probeConfig()
      expect(problems[0]!.message).toMatch(/invalid JSON at offset/)
      expect(problems[0]!.fix).toBeUndefined()
    })
  })

  test("loadConfig still refuses, and names the command that can help", async () => {
    // It must keep refusing: the whole point of #18 is that a wrong setting is an error.
    // What is new is that the refusal is not a dead end.
    await withConfig(CONTRADICTORY(), async () => {
      await expect(loadConfig()).rejects.toThrow(/onesystem doctor --fix/)
    })
  })

  test("a missing config still points at install, not at doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-probe-"))
    const previous = process.env.ONESYSTEM_CONFIG_DIR
    process.env.ONESYSTEM_CONFIG_DIR = dir
    try {
      await expect(loadConfig()).rejects.toThrow(/onesystem install/)
    } finally {
      if (previous === undefined) delete process.env.ONESYSTEM_CONFIG_DIR
      else process.env.ONESYSTEM_CONFIG_DIR = previous
    }
  })
})

describe("repairing it", () => {
  test("the fix produces a config that loads", async () => {
    await withConfig(CONTRADICTORY(), async (path) => {
      const { problems } = await probeConfig()
      const repair = await repairConfig(path, problems)
      expect(repair.changed).toBe(true)
      expect(repair.applied).toEqual(["requestTimeoutSecs = 180"])
      const { config } = await loadConfig()
      expect(config.requestTimeoutSecs).toBe(180)
    })
  })

  test("it changes nothing else: comments, port, and the backend survive", async () => {
    await withConfig(CONTRADICTORY(), async (path) => {
      await repairConfig(path, (await probeConfig()).problems)
      const text = await readFile(path, "utf8")
      expect(text).toContain("// hand written")
      expect(text).toContain('"port": 7399')
      expect(text).toContain('"startupTimeoutSecs": 180')
      // Written as a number, not a quoted one: a string would still parse.
      expect(text).toContain('"requestTimeoutSecs": 180')
      expect(text).not.toContain('"180"')
    })
  })

  test("a problem with no fix is left alone rather than guessed at", async () => {
    // `--fix` has to be safe to run on a file you care about.
    await withConfig('{ "port": 7331, ', async (path) => {
      const before = await readFile(path, "utf8")
      const repair = await repairConfig(path, (await probeConfig()).problems)
      expect(repair.changed).toBe(false)
      expect(repair.applied).toEqual([])
      expect(await readFile(path, "utf8")).toBe(before)
    })
  })

  test("fixing twice writes nothing the second time", async () => {
    await withConfig(CONTRADICTORY(), async (path) => {
      await repairConfig(path, (await probeConfig()).problems)
      const after = await readFile(path, "utf8")
      const second = await repairConfig(path, (await probeConfig()).problems)
      expect(second.changed).toBe(false)
      expect(await readFile(path, "utf8")).toBe(after)
    })
  })
})

describe("the ceiling rule itself", () => {
  const spec = (startup: number) =>
    validate(
      {
        requestTimeoutSecs: 120,
        backends: { x: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["p"], startupTimeoutSecs: startup } },
      },
      "test",
    )

  test("a backend above the ceiling is refused", () => {
    expect(() => spec(180)).toThrow(/exceeds requestTimeoutSecs/)
  })

  test("one exactly at the ceiling is fine", () => {
    expect(() => spec(120)).not.toThrow()
  })

  test("a backend that omits the budget is held to the default of 180", () => {
    // Otherwise a config could dodge the rule by omitting the field, and the default
    // would silently become a value the rule never sees.
    const atDefault: Config = validate(
      { requestTimeoutSecs: 180, backends: { x: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["p"] } } },
      "test",
    )
    expect(atDefault.backends.x!.startupTimeoutSecs).toBe(180)
    expect(() =>
      validate(
        { requestTimeoutSecs: 120, backends: { x: { transport: "stdio-mcp", command: ["/bin/true"], tools: ["p"] } } },
        "test",
      ),
    ).toThrow(/startupTimeoutSecs \(180\) exceeds requestTimeoutSecs \(120\)/)
  })
})

describe("the commands, on a config the old template wrote", () => {
  const CLI = new URL("../src/cli.ts", import.meta.url).pathname

  const run = (args: string[], dir: string): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args], {
        env: { ...process.env, ONESYSTEM_CONFIG_DIR: dir, ONESYSTEM_STATE_DIR: dir },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let out = ""
      child.stdout?.on("data", (d) => (out += String(d)))
      child.stderr?.on("data", (d) => (out += String(d)))
      child.on("close", (code) => resolve({ code: code ?? 1, out }))
    })

  const seed = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-probe-cli-"))
    await writeFile(join(dir, "onesystem.jsonc"), CONTRADICTORY())
    return dir
  }

  test("doctor names the problem and says the fix exists", async () => {
    const dir = await seed()
    const { code, out } = await run(["doctor"], dir)
    expect(out).toMatch(/config: 1 problem/)
    expect(out).toMatch(/fixable: requestTimeoutSecs = 180/)
    expect(out).toMatch(/--fix to apply/)
    // A problem it found is a failure, so a script can rely on the exit code.
    expect(code).not.toBe(0)
  }, 60_000)

  test("doctor --fix repairs the file and the next command works", async () => {
    const dir = await seed()
    const fixed = await run(["doctor", "--fix"], dir)
    expect(fixed.out).toMatch(/fixed: requestTimeoutSecs = 180/)
    expect(fixed.out).toMatch(/config: ok/)

    const after = await run(["config-path"], dir)
    expect(after.code).toBe(0)
    const status = await run(["status"], dir)
    expect(status.code).toBe(0)
    // The repaired config is the one in use, and on the port the file named.
    expect(status.out).toContain("http://127.0.0.1:7399")
  }, 60_000)

  test("stop runs against a broken config instead of refusing", async () => {
    // Nothing is listening, so this is the harmless outcome, but it is the outcome that
    // proves the command got as far as looking. The bug was that it never got there.
    const dir = await seed()
    const { code, out } = await run(["stop"], dir)
    expect(out).not.toMatch(/exceeds requestTimeoutSecs/)
    expect(code).toBe(0)
  }, 60_000)

  test("the other commands still refuse, and name the way out", async () => {
    const dir = await seed()
    for (const cmd of ["status", "start", "serve"]) {
      const { code, out } = await run([cmd], dir)
      expect(`${cmd}: ${code}`).toBe(`${cmd}: 2`)
      expect(out).toMatch(/onesystem doctor --fix/)
    }
  }, 90_000)
})
