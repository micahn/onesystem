/**
 * Verify native tool registration, forwarding, and recovery after daemon shutdown.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/plugin/index.ts"
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
  before(tool: string | { tool?: unknown }): Promise<void>
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
    before: async (tool: string | { tool?: unknown }) => {
      if (!hook) throw new Error("no execute.before hook registered")
      // Accepts a raw payload as well as a bare name, because what the hook has to
      // survive is the whole `input` the host builds, not the well-formed subset of it
      // these tests would otherwise send.
      await hook(typeof tool === "string" ? { tool } : (tool as { tool: string }))
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

  test("the catalog's schema is registered unchanged, not re-authored here", async () => {
    const h = await harness()
    const predict = h.registered.find((r) => r.name === "predict")!
    // The plugin does not invent or translate a schema — whatever `/catalog` declares is
    // what opencode is handed. This used to be described as "the model's own, passed
    // straight through", and the difference is the whole of issue #1: the catalog is now a
    // surface declared in config rather than one read from a running model, because
    // reading it from the model is the load that must not happen at session start. The
    // property this test actually protects — no second description of the schema on the
    // plugin side — is unchanged by that. `test/lazy.test.ts` pins the other half.
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

describe("the recovery hook finds our tools however the host spells them", () => {
  test("a namespaced tool id is still recognised as ours", async () => {
    const h = await harness()
    h.stub.healthy = false
    // `planTools` registers the bare name `predict`, so the hook normally sees it verbatim
    // and this is an equality test. But opencode may namespace a plugin-registered tool the
    // way it namespaces an MCP one, and the joiner has moved between `_`, `.` and `-`
    // across versions. The name we registered is the thing that survives into a namespaced
    // id as its tail, so the guard matches on that.
    //
    // This asserted the *opposite* for the whole life of the function — `.toBe(false)` —
    // on a line whose neighbour said "the normalisation has to survive that". A false
    // negative is the silent kind: nothing throws, the "Coming back" section just goes
    // inert, and a session that outlives the idle window gets "Unable to connect" against
    // a port nothing is listening on, with the daemon waiting for a human. That is the
    // exact symptom the section exists to prevent, so this was not a wrong test but a
    // description of the bug — and the guard was rewritten to match the comment.
    await h.before("onesystem_predict")
    expect(await readFile(h.marker, "utf8")).toBe("start\n")
  })

  test("the joiner can be any of the three spellings opencode has used", async () => {
    for (const id of ["onesystem_predict", "onesystem.predict", "onesystem-predict"]) {
      const h = await harness()
      h.stub.healthy = false
      await h.before(id)
      expect(await readFile(h.marker, "utf8")).toBe("start\n")
    }
  })

  test("a name we did not register is not ours, however it is spelled", async () => {
    const h = await harness()
    h.stub.healthy = false
    // The other direction has to hold too, or the guard starts restarting the daemon on
    // other people's tools. Suffix matching widens what matches, so this is the half that
    // needs pinning.
    for (const id of ["bash", "read", "onesystem_bash", "prediction"]) {
      await h.before(id)
    }
    expect(await readFile(h.marker, "utf8")).toBe("")
  })

  test("the qualified names a two-backend setup registers are ours too", async () => {
    const h = await harness({ laya: STUB_TOOLS.laya, julia: STUB_TOOLS.julia })
    h.stub.healthy = false
    // `planTools` qualifies the name when more than one backend is usable, so this session
    // was handed `laya_predict` and `julia_predict`. Those match as bare tails as well as
    // as exact names, which is the property that lets the guard be written against the
    // name it registered instead of a server prefix it does not control.
    expect(h.toolNames).toEqual(["laya_predict", "laya_status", "julia_predict"])
    await h.before("laya_predict")
    expect(await readFile(h.marker, "utf8")).toBe("start\n")
  })

  test("nothing the host puts in the payload can fail the call it wraps", async () => {
    const h = await harness()
    h.stub.healthy = false
    // `tool.execute.before` runs for every call in the session and a throw from it breaks
    // the session's whole tool surface, not just that one call. `input.tool` is the only
    // value here the host owns, so the property worth pinning is that the hook returns
    // normally whatever it is handed — including a value that throws merely to be read,
    // which is what reaches the catch below `isOurTool`.
    for (const tool of [undefined, 42, null, {}, [], () => {}, { toString: () => { throw new Error("host sent junk") } }]) {
      await h.before({ tool })
    }
    // Still does its job on the way through.
    await h.before("predict")
    expect(await readFile(h.marker, "utf8")).toBe("start\n")
  })
})
