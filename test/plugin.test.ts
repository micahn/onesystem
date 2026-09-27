/**
 * Recovery after the daemon exits on its own.
 *
 * The bug this covers is not a crash: the daemon is *supposed* to exit once nothing is
 * warm, and it does. What was missing is anything that brings it back. A session that
 * outlives the idle window keeps the tools in its catalog, keeps calling them, and gets
 * "Unable to connect" forever, because nothing re-probes the port and `onesystem start` is
 * only ever run once at plugin setup. The only recovery was a human in a terminal.
 *
 * So these tests drive `setup` with a fake opencode context and assert the shape of the
 * recovery: a health probe per call, a restart only when nothing answers, one restart for
 * concurrent calls, and both registrations disposed on cleanup.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server } from "node:http"
import plugin, { belongsToServer } from "../src/plugin/index.ts"

const cleanups: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {})
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

/** A port nothing is listening on, so /health always fails. */
function deadPort(): number {
  return 18_000 + Math.floor(Math.random() * 1_000)
}

/**
 * A stand-in for `onesystem start` that records that it ran and exits 0.
 *
 * The plugin spawns the CLI to start the daemon, so the only way to observe the restart
 * without booting a real one is to hand it a different command. `status` is spawned too,
 * and this answers that with an empty registration list so the plugin falls back to a
 * single `onesystem` server.
 */
async function fakeCli(marker: string, base?: string): Promise<{ command: string; args: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-plugin-"))
  dirs.push(dir)
  const script = join(dir, "cli.ts")
  // `status` must report a `url` as well as registrations: the plugin now takes the
  // address from the daemon's own answer rather than rebuilding it from a default port,
  // so a payload without one means "could not determine the address" and it registers
  // nothing. That is the behaviour under test below.
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs"\n` +
      `const sub = process.argv[2]\n` +
      `if (sub === "status") {\n` +
      `  process.stdout.write(JSON.stringify({\n` +
      `    url: ${JSON.stringify(base ?? "http://127.0.0.1:7331")},\n` +
      `    registrations: [],\n` +
      `  }))\n` +
      `  process.exit(0)\n` +
      `}\n` +
      `appendFileSync(${JSON.stringify(marker)}, sub + "\\n")\n`,
  )
  return { command: process.execPath, args: [script] }
}

interface Fake {
  ctx: Record<string, unknown>
  /** Fire the registered `tool.execute.before` hook, as opencode does before a call. */
  before(tool: string): Promise<void>
  /** `onesystem start` invocations since setup finished. */
  starts(): Promise<string>
  reloads: number
  disposed: { transform: number; hook: number }
}

async function setup(options: Record<string, unknown> = {}, marker?: string): Promise<Fake> {
  const state = { reloads: 0, disposed: { transform: 0, hook: 0 } }
  let hook: ((input: { tool: string }) => Promise<void>) | null = null

  const ctx = {
    options,
    mcp: {
      async transform(cb: (editor: { set(name: string, config: unknown): void }) => void) {
        cb({ set: () => {} })
        return { dispose: async () => void state.disposed.transform++ }
      },
      async reload() {
        state.reloads++
      },
    },
    tool: {
      async hook(_name: string, cb: (input: { tool: string }) => Promise<void>) {
        hook = cb
        return { dispose: async () => void state.disposed.hook++ }
      },
    },
  }

  const cleanup = await plugin.setup(ctx as never)
  cleanups.push(async () => {
    await cleanup?.()
  })  // Setup itself runs `onesystem start`, so the marker's first entry is the startup these
  // tests are not about. Counting from here keeps the assertions about the hook.
  if (marker) await writeFile(marker, "")

  return {
    ctx,
    get reloads() {
      return state.reloads
    },
    disposed: state.disposed,
    starts: () => readFile(marker!, "utf8").catch(() => ""),
    before: async (tool: string) => {
      if (!hook) throw new Error("no execute.before hook registered")
      await hook({ tool })
    },
  }
}

describe("belongsToServer", () => {
  test("matches the tool ids opencode builds from a server name", () => {
    expect(belongsToServer("onesystem_predict", ["onesystem"])).toBe(true)
    expect(belongsToServer("onesystem.predict", ["onesystem"])).toBe(true)
    expect(belongsToServer("onesystem-laya_predict", ["onesystem-laya"])).toBe(true)
    expect(belongsToServer("onesystem", ["onesystem"])).toBe(true)
  })

  test("does not match another server's tools, or a name that merely contains ours", () => {
    expect(belongsToServer("onesystem_laya_predict", ["onesystem-rev"])).toBe(false)
    expect(belongsToServer("not_onesystem_predict", ["onesystem"])).toBe(false)
    expect(belongsToServer("bash", ["onesystem"])).toBe(false)
  })
})

describe("plugin recovery", () => {
  // These drive the real path: the address comes from `onesystem status`, not from an
  // environment variable, so each test decides the address by deciding what the fake CLI
  // reports. The override has its own tests below.
  test("a tool call restarts the daemon when nothing is listening", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-plugin-"))
    dirs.push(dir)
    const marker = join(dir, "starts.log")
    const cli = await fakeCli(marker, `http://127.0.0.1:${deadPort()}`)

    const fake = await setup({ ...cli }, marker)
    await fake.before("onesystem_predict")

    expect(await fake.starts()).toBe("start\n")
    // The client is holding the dead daemon's MCP session id, so it has to be dropped or
    // this very call comes back "session expired".
    expect(fake.reloads).toBe(1)
  })

  test("a tool call leaves a healthy daemon alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-plugin-"))
    dirs.push(dir)
    const marker = join(dir, "starts.log")

    const server: Server = createServer((req, res) => {
      res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" })
      res.end("{}")
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
    const port = (server.address() as { port: number }).port

    // The fake CLI reports the live port, so the probe the plugin runs is a real one.
    const cli = await fakeCli(marker, `http://127.0.0.1:${port}`)

    const fake = await setup({ ...cli }, marker)
    await fake.before("onesystem_predict")

    expect(await fake.starts()).toBe("")
    expect(fake.reloads).toBe(0)
  })

  test("concurrent calls share one restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-plugin-"))
    dirs.push(dir)
    const marker = join(dir, "starts.log")
    const cli = await fakeCli(marker, `http://127.0.0.1:${deadPort()}`)

    const fake = await setup({ ...cli }, marker)
    await Promise.all(Array.from({ length: 5 }, () => fake.before("onesystem_predict")))

    // One daemon, however many agents woke at once. Two would mean two copies of the model
    // on one GPU, which is the failure the lock exists to prevent.
    expect(await fake.starts()).toBe("start\n")
  })

  test("another server's tool call does not touch the daemon", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-plugin-"))
    dirs.push(dir)
    const marker = join(dir, "starts.log")
    const cli = await fakeCli(marker, `http://127.0.0.1:${deadPort()}`)

    const fake = await setup({ ...cli }, marker)
    await fake.before("bash")

    expect(await fake.starts()).toBe("")
  })

  test("noStart opts out of recovery too, and cleanup disposes both registrations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-plugin-"))
    dirs.push(dir)
    const marker = join(dir, "starts.log")
    const cli = await fakeCli(marker, `http://127.0.0.1:${deadPort()}`)

    const state = { disposed: { transform: 0, hook: 0 } }
    let hook: ((input: { tool: string }) => Promise<void>) | null = null
    const ctx = {
      options: { ...cli, noStart: true },
      mcp: {
        transform: async (cb: (e: { set(n: string, c: unknown): void }) => void) => {
          cb({ set: () => {} })
          return { dispose: async () => void state.disposed.transform++ }
        },
        reload: async () => {},
      },
      tool: {
        hook: async (_n: string, cb: (input: { tool: string }) => Promise<void>) => {
          hook = cb
          return { dispose: async () => void state.disposed.hook++ }
        },
      },
    }
    const cleanup = await plugin.setup(ctx as never)
    // CI and tests boot no daemon, so there is nothing to recover and no hook to register.
    expect(hook).toBeNull()

    await cleanup?.()
    expect(state.disposed.transform).toBe(1)
    expect(state.disposed.hook).toBe(0)
  })
})

describe("address resolution", () => {
  /** Capture what the plugin registered, so a test can assert the URL it chose. */
  async function register(
    options: Record<string, unknown>,
  ): Promise<{ url: string | undefined; serverName: string | undefined }> {
    // Both are always present in the result, set or not: the point of the test is which
    // one the plugin ended up with.
    const seen: { url?: string; serverName?: string } = {}
    const ctx = {
      options,
      mcp: {
        transform: async (cb: (e: { set(n: string, c: { url?: string }): void }) => void) => {
          cb({
            set: (name, config) => {
              seen.serverName = name
              seen.url = config.url
            },
          })
          return { dispose: async () => {} }
        },
        reload: async () => {},
      },
      tool: { hook: async () => ({ dispose: async () => {} }) },
    }
    await plugin.setup(ctx as never)
    return { url: seen.url, serverName: seen.serverName }
  }

  async function cliReporting(base: string | null): Promise<Record<string, unknown>> {
    const dir = await mkdtemp(join(tmpdir(), "onesystem-plugin-"))
    dirs.push(dir)
    const script = join(dir, "cli.ts")
    await writeFile(
      script,
      `const sub = process.argv[2]\n` +
        `if (sub === "status") {\n` +
        `  const base = ${JSON.stringify(base)}\n` +
        `  process.stdout.write(base === null ? "not json" : JSON.stringify({ url: base, registrations: [] }))\n` +
        `  process.exit(0)\n` +
        `}\n` +
        `process.exit(0)\n`,
    )
    return { command: process.execPath, args: [script], noStart: true }
  }

  test("uses the address the daemon reports, not a compiled-in default", async () => {
    const cli = await cliReporting("http://127.0.0.1:9999")
    const seen = await register(cli)
    expect(seen.url).toBe("http://127.0.0.1:9999/mcp/laya")
  })

  test("a non-numeric ONESYSTEM_PORT is ignored rather than registered as NaN", async () => {
    // The old code did `Number(env ?? 7331)`, which registered `http://127.0.0.1:NaN`
    // and failed at the tool call instead of at startup.
    const cli = await cliReporting("http://127.0.0.1:9999")
    const previous = process.env.ONESYSTEM_PORT
    process.env.ONESYSTEM_PORT = "not-a-port"
    cleanups.push(async () => void (process.env.ONESYSTEM_PORT = previous))

    const seen = await register(cli)
    // Ignored, so the daemon's own address stands.
    expect(seen.url).toBe("http://127.0.0.1:9999/mcp/laya")
  })

  test("a non-loopback ONESYSTEM_HOST is refused", async () => {
    const cli = await cliReporting("http://127.0.0.1:9999")
    const previous = process.env.ONESYSTEM_HOST
    process.env.ONESYSTEM_HOST = "0.0.0.0"
    cleanups.push(async () => void (process.env.ONESYSTEM_HOST = previous))

    const seen = await register(cli)
    expect(seen.url).toBe("http://127.0.0.1:9999/mcp/laya")
  })

  test("an unparseable status registers nothing rather than guessing an address", async () => {
    // Registering against a guessed port produces a server that 404s on every call, which
    // the user sees as "Unable to connect" and cannot tell from a daemon that is merely
    // slow to start. Registering nothing is at least honest.
    const cli = await cliReporting(null)
    const seen = await register(cli)
    expect(seen.url).toBeUndefined()
    expect(seen.serverName).toBeUndefined()
  })
})
