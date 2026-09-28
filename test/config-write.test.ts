/**
 * `onesystem install` writes the config, because a printed block is a manual step.
 *
 * The flow used to end with the installer printing a snippet and the README telling you to
 * paste it. That copy was the only part of the install a person had to get right, and
 * nothing checked it: a block missing a key still parses, the daemon still starts, and the
 * mistake shows up as an error payload on the first tool call. These tests pin the write.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "jsonc-parser"
import { writeBackend } from "../src/config-edit.ts"
import { validate } from "../src/config.ts"

const SAMPLE = `{
  // keep this, it is the whole point
  "port": 7331,
  "backends": {
    "laya": {
      "transport": "stdio-mcp",
      // a hand-written command a person chose
      "command": ["/my/own/shim"],
      "tools": ["predict"]
    },
    "julia": {
      "transport": "stdio-mcp",
      "command": ["/bin/true"],
      "tools": ["predict"],
      "enabled": false
    }
  }
}
`

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-write-"))
  const path = join(dir, "onesystem.jsonc")
  await writeFile(path, SAMPLE)
  return path
}

const read = async (path: string) => parse(await readFile(path, "utf8")) as Record<string, any>

describe("writing an installed backend into the config", () => {
  test("it adds a backend that was not there, with real paths", async () => {
    const path = await scratch()
    const backend = {
      transport: "stdio-mcp",
      command: ["/data/runtimes/laya/.venv/bin/laya-mcp-server"],
      env: { LAYA_PYTHON: "/data/runtimes/laya/.venv/bin/python" },
      tools: ["predict", "status"],
    }
    const { changed } = await writeBackend(path, "kev", backend, { enabled: true })
    expect(changed).toBe(true)

    const doc = await read(path)
    expect(doc.backends.kev.command[0]).toBe("/data/runtimes/laya/.venv/bin/laya-mcp-server")
    expect(doc.backends.kev.env.LAYA_PYTHON).toBe("/data/runtimes/laya/.venv/bin/python")
    expect(doc.backends.kev.tools).toEqual(["predict", "status"])
    expect(doc.backends.kev.enabled).toBe(true)
  })

  test("the result is a config the validator accepts", async () => {
    // The point of the whole change. A written block that fails validation is no better
    // than a printed one nobody pasted, so this goes through the real validator rather
    // than checking the shape of the object we happened to pass in.
    const path = await scratch()
    await writeBackend(
      path,
      "kev",
      { transport: "stdio-mcp", command: ["/data/bin/server"], tools: ["predict"] },
      { enabled: true },
    )
    const doc = await read(path)
    expect(() => validate(doc, path)).not.toThrow()
  })

  test("comments in the rest of the file survive", async () => {
    // `modify`/`applyEdits` is the whole reason this module exists. A write that went
    // through JSON.parse would delete the file's value the first time anyone ran a command
    // that touched it.
    const path = await scratch()
    await writeBackend(path, "kev", { transport: "stdio-mcp", command: ["/x"], tools: ["p"] })
    const onDisk = await readFile(path, "utf8")
    expect(onDisk).toContain("// keep this, it is the whole point")
    expect(onDisk).toContain("// a hand-written command a person chose")
  })

  test("a hand-written command is replaced, not merged over", async () => {
    // Merge would keep `/my/own/shim` because the new block has a `command` too, so the
    // distinction only shows on a key the new block omits. `baseUrl` is that key here:
    // leaving it behind means a config that describes two servers at once.
    const path = await scratch()
    await writeBackend(
      path,
      "laya",
      { transport: "stdio-mcp", command: ["/data/bin/laya-mcp-server"], tools: ["predict"] },
      { enabled: true },
    )
    const laya = (await read(path)).backends.laya
    expect(laya.command).toEqual(["/data/bin/laya-mcp-server"])
    expect(laya.baseUrl).toBeUndefined()
  })

  test("merge keeps a key the new block does not mention", async () => {
    // The other half of the trade. `toolPrefix` is worth keeping: it is a naming decision
    // a person made once, and losing it silently renames every tool on the backend.
    const path = await scratch()
    await writeFile(
      path,
      SAMPLE.replace('"tools": ["predict"]', '"tools": ["predict"], "toolPrefix": "laya_"'),
    )
    await writeBackend(
      path,
      "laya",
      { transport: "stdio-mcp", command: ["/data/bin/server"], tools: ["predict"] },
      { enabled: true },
    )
    expect((await read(path)).backends.laya.toolPrefix).toBe("laya_")
  })

  test("enabled is set from the argument, and preserved when there is none", async () => {
    const path = await scratch()
    // julia is `enabled: false` in the sample. Rewriting its block must not turn it on.
    await writeBackend(path, "julia", { transport: "stdio-mcp", command: ["/x"], tools: ["p"] })
    expect((await read(path)).backends.julia.enabled).toBe(false)

    await writeBackend(
      path,
      "julia",
      { transport: "stdio-mcp", command: ["/x"], tools: ["p"] },
      { enabled: true },
    )
    expect((await read(path)).backends.julia.enabled).toBe(true)
  })

  test("a second write of the same backend is a no-op", async () => {
    // `onesystem install` is re-runnable, and an install that reports a change every time
    // makes a person wonder what it is touching.
    const path = await scratch()
    const backend = { transport: "stdio-mcp", command: ["/x"], tools: ["p"] }
    await writeBackend(path, "kev", backend, { enabled: true })
    const second = await writeBackend(path, "kev", backend, { enabled: true })
    expect(second.changed).toBe(false)
  })

  test("a config that is not valid JSONC is refused, not rewritten", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "onesystem-write-")), "broken.jsonc")
    const broken = '{ "backends": { "laya": { "command": [ }'
    await writeFile(path, broken)
    await expect(
      writeBackend(path, "kev", { transport: "stdio-mcp", command: ["/x"], tools: ["p"] }),
    ).rejects.toThrow(/not valid JSONC/)
    // Refusing must not have half-written it.
    expect(await readFile(path, "utf8")).toBe(broken)
  })
})

describe("merging a backend into one that already exists", () => {
  test("env is merged key by key, not replaced", async () => {
    // The bug this caught. An install knows `LAYA_PYTHON` and nothing else, so replacing
    // `env` wholesale dropped the two settings a person had put there to make the model
    // behave: `LAYA_DEVICE` and `LAYA_PRELOAD`. The second is load-bearing -- it is what
    // stops the model loading outside a request, which is the whole laziness contract.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-write-"))
    const path = join(dir, "onesystem.jsonc")
    await writeFile(
      path,
      `{
  "backends": {
    "laya": {
      "transport": "stdio-mcp",
      "command": ["/my/shim"],
      "env": { "LAYA_DEVICE": "cuda", "LAYA_PRELOAD": "0", "LAYA_IDLE_UNLOAD_SECS": "300" },
      "toolPrefix": "laya_",
      "tools": ["predict"]
    }
  }
}
`,
    )
    await writeBackend(path, "laya", {
      transport: "stdio-mcp",
      command: ["/data/bin/laya-mcp-server"],
      env: { LAYA_PYTHON: "/data/.venv/bin/python" },
      tools: ["predict", "status"],
    })

    const env = (await read(path)).backends.laya.env
    // The installer's value lands.
    expect(env.LAYA_PYTHON).toBe("/data/.venv/bin/python")
    // The person's values survive.
    expect(env.LAYA_DEVICE).toBe("cuda")
    expect(env.LAYA_PRELOAD).toBe("0")
    expect(env.LAYA_IDLE_UNLOAD_SECS).toBe("300")
    // And the command did change, which is the point of running an install.
    expect((await read(path)).backends.laya.command).toEqual(["/data/bin/laya-mcp-server"])
  })

  test("tools is replaced, because the model is authoritative about its own surface", async () => {
    // env merges; tools must not. A union would advertise a name the model has dropped,
    // and that name fails at the moment of the call rather than at startup.
    const dir = await mkdtemp(join(tmpdir(), "onesystem-write-"))
    const path = join(dir, "onesystem.jsonc")
    await writeFile(
      path,
      `{ "backends": { "laya": { "transport": "stdio-mcp", "command": ["/x"],
        "tools": ["predict", "gone_in_this_release"] } } }
`,
    )
    await writeBackend(path, "laya", {
      transport: "stdio-mcp",
      command: ["/y"],
      tools: ["predict"],
    })
    expect((await read(path)).backends.laya.tools).toEqual(["predict"])
  })
})
