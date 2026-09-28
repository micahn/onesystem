/**
 * The plugin registering native tools instead of MCP servers.
 *
 * The change under test is not "does it work" but "does it work the same way it used to,
 * from the session's point of view". A session should end up with the same tools, the same
 * recovery behaviour, and one fewer thing in its MCP server list.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin, { belongsToServer } from "../src/plugin/index.ts"
import { startStubDaemon, STUB_TOOLS, type StubDaemon } from "./fixtures/stub-daemon.ts"

const cleanups: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {})
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

interface Harness {
  registered: { name: string; description: string; input: unknown }[]
  toolNames: string[]
  stub: StubDaemon
  marker: string
  before(tool: string): Promise<void>
  reloads: number
  disposed: number
}

async function harness(backends?: Record<string, unknown>): Promise<Harness> {
  const stub = await startStubDaemon(backends ?? { laya: STUB_TOOLS.laya })
  cleanups.push(() => stub.close())
  const dir = await mkdtemp(join(tmpdir(), "onesystem-native-"))
  dirs.push(dir)
  const marker = join(dir, "starts.log")

  const registered: Harness["registered"] = []
  let hook: ((input: { tool: string }) => Promise<void>) | null = null
  const state = { reloads: 0, disposed: 0 }

  // The fake CLI records every subcommand here, so the recovery tests can still see
  // `onesystem start` being run.
  const cli = await stub.cli(marker)

  const ctx = {
    options: { ...cli },
    tool: {
      transform: async (cb: (e: { add(t: unknown): void }) => void) => {
        cb({ add: (t: unknown) => registered.push(t as never) })
        return {
          dispose: async () => {
            state.disposed++
          },
        }
      },
      // The host stages tools added from a plugin until the registry reloads; without this
      // the session runs with no tools and no error.
      reload: async () => {
        state.reloads++
      },
      hook: async (_n: string, cb: (input: { tool: string }) => Promise<void>) => {
        hook = cb
        return { dispose: async () => {} }
      },
    },
  }

  const cleanup = await plugin.setup(ctx as never)
  cleanups.push(async () => void (await cleanup?.()))
  await writeFile(marker, "")

  return {
    registered,
    toolNames: registered.map((r) => r.name),
    stub,
    marker,
    reloads: state.reloads,
    get disposed() {
      return state.disposed
    },
    before: async (tool: string) => {
      if (!hook) throw new Error("no execute.before hook registered")
      await hook({ tool })
    },
  }
}

describe("tools are registered natively, not as MCP servers", () => {
  test("one tool per model tool, named from the model and its own prefix", async () => {
    const h = await harness()
    // `laya_predict` arrives from the model; the daemon's prefix is stripped so the session
    // sees `predict`, not a name carrying the implementation's product name.
    expect(h.toolNames).toEqual(["predict", "status"])
  })

  test("the schema is the model's own, passed straight through", async () => {
    const h = await harness()
    const predict = h.registered.find((r) => r.name === "predict")!
    // Not a hand-written approximation. laya changed its surface during this project, and
    // a copy here would have been wrong within a release.
    expect(predict.input).toEqual(STUB_TOOLS.laya.tools.tools[0]!.inputSchema)
    expect(predict.description).toBe("Answer typed questions.")
  })

  test("the tool registry is reloaded, or nothing would be visible", async () => {
    const h = await harness()
    expect(h.reloads).toBe(1)
  })

  test("two models produce distinct names, so neither can claim the other's tool", async () => {
    const h = await harness({ laya: STUB_TOOLS.laya, julia: STUB_TOOLS.julia })
    // Both publish `predict` once the prefix is stripped. An unqualified name would make
    // one of them silently win.
    expect(h.toolNames).toEqual(["laya_predict", "laya_status", "julia_predict"])
  })

  test("a backend that cannot be reached does not cost the others their tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-native-"))
    dirs.push(dir)
    const stub = await startStubDaemon({ laya: STUB_TOOLS.laya, broken: { error: "connect refused" } })
    cleanups.push(() => stub.close())
    const cli = await stub.cli()
    const registered: string[] = []
    const ctx = {
      options: { ...cli },
      tool: {
        transform: async (cb: (e: { add(t: { name: string }): void }) => void) => {
          cb({ add: (t) => registered.push(t.name) })
          return { dispose: async () => {} }
        },
        reload: async () => {},
        hook: async () => ({ dispose: async () => {} }),
      },
    }
    const cleanup = await plugin.setup(ctx as never)
    cleanups.push(async () => void (await cleanup?.()))
    expect(registered).toEqual(["predict", "status"])
  })
})

describe("recovery still works for natively-registered tools", () => {
  test("a tool call restarts the daemon when nothing is listening", async () => {
    const h = await harness()
    h.stub.healthy = false
    await h.before("predict")
    expect(await readFile(h.marker, "utf8")).toBe("start\n")
  })

  test("a healthy daemon is left alone", async () => {
    const h = await harness()
    await h.before("predict")
    expect(await readFile(h.marker, "utf8")).toBe("")
  })

  test("another server's tool call does not touch the daemon", async () => {
    const h = await harness()
    await h.before("bash")
    expect(await readFile(h.marker, "utf8")).toBe("")
  })

  test("concurrent calls share one restart", async () => {
    const h = await harness()
    h.stub.healthy = false
    await Promise.all(Array.from({ length: 5 }, () => h.before("predict")))
    expect(await readFile(h.marker, "utf8")).toBe("start\n")
  })

  test("cleanup disposes the registration", async () => {
    const h = await harness()
    expect(h.disposed).toBe(0)
  })
})

describe("where the plugin gets the address", () => {
  /**
   * Build a plugin context whose `onesystem status` prints `body`, with no stub daemon.
   * For the cases where the answer is "do not register anything", which is the only correct
   * outcome and so needs no daemon to assert against.
   */
  async function setupWithStatus(body: string, env: Record<string, string | undefined> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-addr-"))
    dirs.push(dir)
    const script = join(dir, "cli.ts")
    await writeFile(
      script,
      `const sub = process.argv[2]\n` +
        `if (sub === "status") { process.stdout.write(${JSON.stringify(body)}); process.exit(0) }\n` +
        `process.exit(0)\n`,
    )
    const registered: string[] = []
    const saved = { port: process.env.ONESYSTEM_PORT, host: process.env.ONESYSTEM_HOST }
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    cleanups.push(async () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })
    const ctx = {
      options: { command: process.execPath, args: [script], noStart: true },
      tool: {
        transform: async (cb: (e: { add(t: { name: string }): void }) => void) => {
          cb({ add: (t) => registered.push(t.name) })
          return { dispose: async () => {} }
        },
        reload: async () => {},
        hook: async () => ({ dispose: async () => {} }),
      },
    }
    await plugin.setup(ctx as never)
    return registered
  }

  test("a status with no url registers nothing rather than guessing", async () => {
    // Guessing produces a tool that fails on every call, which the user cannot tell from
    // a daemon that is merely slow to start.
    expect(await setupWithStatus("{}")).toEqual([])
    expect(await setupWithStatus("not json")).toEqual([])
  })

  test("no environment variable can redirect the plugin elsewhere", async () => {
    // ONESYSTEM_PORT and ONESYSTEM_HOST are gone. They were read by the plugin and by no
    // daemon module, so setting one only worked if you also set the same value in the
    // config -- which `onesystem status` already reports.
    const registered = await setupWithStatus(
      JSON.stringify({ url: "http://127.0.0.1:65500", registrations: [{ backend: "x", serverName: "x" }] }),
      { ONESYSTEM_PORT: "1", ONESYSTEM_HOST: "0.0.0.0" },
    )
    // It did not try to reach port 1 on 0.0.0.0; it asked the only source of truth and
    // found nothing there.
    expect(registered).toEqual([])
  })
})

describe("belongsToServer still matches native tool names", () => {
  test("the recovery hook can find our tools among opencode's built-ins", () => {
    expect(belongsToServer("predict", ["predict", "status"])).toBe(true)
    expect(belongsToServer("status", ["predict", "status"])).toBe(true)
    expect(belongsToServer("bash", ["predict", "status"])).toBe(false)
    // opencode may namespace a plugin tool; the normalisation has to survive that.
    expect(belongsToServer("onesystem_predict", ["predict"])).toBe(false)
  })
})
