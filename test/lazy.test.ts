/**
 * Check lazy startup through a real daemon and MCP child. A spawn marker proves
 * that health, catalog, and plugin setup load nothing. Idle tests use a short window.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validate, type Config } from "../src/config.ts"
import { runDaemon, probe } from "../src/daemon.ts"
import type { HealthReport } from "../src/health.ts"
import plugin from "../src/plugin/index.ts"

const cleanups: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {})
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function workspace(): Promise<{ dir: string; marker: string; port: number }> {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-lazy-"))
  dirs.push(dir)
  return { dir, marker: join(dir, "marker.log"), port: 7000 + Math.floor(Math.random() * 900) }
}

function testConfig(port: number, marker: string, idleShutdownSecs: number): Config {
  return validate(
    {
      port,
      idleShutdownSecs,
      idleSweepSecs: 1,
      requestTimeoutSecs: 20,
      backends: {
        fake: {
          transport: "stdio-mcp",
          command: [process.execPath, new URL("./fixtures/fake-mcp.ts", import.meta.url).pathname],
          env: { FAKE_MCP_MARKER: marker },
          startupTimeoutSecs: 30,
          tools: ["decide"],
        },
      },
    },
    "test",
  )
}

async function markerLines(marker: string): Promise<string[]> {
  try {
    return (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

describe("lazy start", () => {
  test("nothing loads until the first request", async () => {
    const { dir, marker, port } = await workspace()
    const config = testConfig(port, marker, 300)
    const lockFile = join(dir, "daemon.lock")

    // `idleShutdownSecs: 300` and a live daemon: if the sweep were wrong about
    // "never started", it would exit here and the health probe would fail.
    const daemon = await runDaemon(config, { lockFile, handleSignals: false })
    cleanups.push(() => daemon.close())

    const url = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 10_000
    let health: HealthReport | null = null
    while (Date.now() < deadline && !health) {
      await Bun.sleep(50)
      health = await probe(url)
    }

    expect(health).not.toBeNull()
    expect(health!.status).toBe("ok")

    // The heart of it: the daemon is up and healthy, and the child has not spawned.
    expect(await markerLines(marker)).toEqual([])
    expect(health!.backends[0]!.state).toBe("cold")
  }, 30_000)

  test("the whole plugin setup path loads no model", async () => {
    // The end-to-end version, because the bug was never in `/catalog` alone: it was that
    // session start goes through it. Setup is `onesystem start` (a health probe) then
    // `GET /catalog`, and the old `/catalog` forwarded `tools/list`, so every session paid
    // a model load per enabled backend before the agent had asked anything.
    //
    // Driven through the real plugin against the real daemon and the real child, with the
    // same marker file. A test that only checked the endpoint would still pass if the
    // plugin started calling something else expensive instead.
    const { dir, marker, port } = await workspace()
    const config = testConfig(port, marker, 300)
    const lockFile = join(dir, "daemon.lock")
    const configPath = join(dir, "onesystem.json")
    await writeFile(
      configPath,
      JSON.stringify({
        port,
        idleShutdownSecs: 300,
        idleSweepSecs: 1,
        backends: {
          fake: {
            transport: "stdio-mcp",
            command: [process.execPath, new URL("./fixtures/fake-mcp.ts", import.meta.url).pathname],
            env: { FAKE_MCP_MARKER: marker },
            tools: ["decide"],
          },
        },
      }),
    )

    const daemon = await runDaemon(config, { lockFile, handleSignals: false })
    cleanups.push(() => daemon.close())
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 200 && !(await probe(url)); i++) await Bun.sleep(50)

    const registered: { name: string }[] = []
    let hook: ((input: { tool: string }) => Promise<void>) | null = null
    const cli = process.execPath
    const cliArgs = [new URL("../src/cli.ts", import.meta.url).pathname]
    type Added = { name: string }
    type Editor = { add(t: Added): void }
    type ToolCtx = {
      transform: (cb: (e: Editor) => void) => Promise<{ dispose(): Promise<void> }>
      reload: () => Promise<void>
      hook: (n: string, cb: (input: { tool: string }) => Promise<void>) => Promise<{ dispose(): Promise<void> }>
    }

    const saved = { config: process.env.ONESYSTEM_CONFIG_DIR }
    process.env.ONESYSTEM_CONFIG_DIR = dir
    cleanups.push(async () => {
      process.env.ONESYSTEM_CONFIG_DIR = saved.config
    })

    const tool: ToolCtx = {
      transform: async (cb) => {
        cb({ add: (t) => void registered.push(t) })
        return { dispose: async () => {} }
      },
      reload: async () => {},
      hook: async (_n, cb) => {
        hook = cb
        return { dispose: async () => {} }
      },
    }

    const cleanup = await plugin.setup({
      options: { command: cli, args: cliArgs },
      tool,
    } as never)
    cleanups.push(async () => void (await cleanup?.()))

    // It registered a real tool...
    expect(registered.map((r) => r.name)).toEqual(["decide"])
    // ...and no model was loaded to do it. This is the invariant, end to end.
    expect(await markerLines(marker)).toEqual([])

    // And the recovery hook is live, so a tool call still works afterwards.
    expect(typeof hook).toBe("function")
    await hook!({ tool: "decide" })
    expect(await markerLines(marker)).toEqual([])
  }, 40_000)

  test("GET /catalog does not spawn the child", async () => {
    // The third case, and the one that was missing. `lazy.test.ts` probed /health and never
    // issued /catalog — the single endpoint that broke the invariant it was written to pin.
    //
    // The call chain was: plugin setup -> fetchCatalog -> GET /catalog -> backends.call
    // ("tools/list") -> Supervisor.call, which cold-starts on any method. So opening a
    // session was a Promise.all of model loads, one per enabled backend, paid before the
    // agent had asked anything — while the plugin's own header claimed setup costs "a
    // process spawn and a health probe". A unit test with a mocked port would have proved
    // nothing about whether a process appeared, so this asserts against the real daemon and
    // the same marker file the spawn test already uses.
    const { dir, marker, port } = await workspace()
    const config = testConfig(port, marker, 300)
    const lockFile = join(dir, "daemon.lock")

    const daemon = await runDaemon(config, { lockFile, handleSignals: false })
    cleanups.push(() => daemon.close())

    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 200 && !(await probe(url)); i++) await Bun.sleep(50)

    const res = await fetch(`${url}/catalog`)
    expect(res.status).toBe(200)

    // It still answers usefully: a session can register tools from this.
    const catalog = (await res.json()) as { backends: { backend: string; toolPrefix?: string; tools: { tools: { name: string }[] } }[] }
    expect(catalog.backends).toHaveLength(1)
    expect(catalog.backends[0]!.backend).toBe("fake")
    // Wire names, prefix applied by the daemon, so planTools strips back to `decide`.
    expect(catalog.backends[0]!.tools.tools.map((t) => t.name)).toEqual(["decide"])

    // And the point of the whole thing: no process.
    expect(await markerLines(marker)).toEqual([])
    expect((await probe(url))!.backends[0]!.state).toBe("cold")
  }, 30_000)

  test("the first MCP request spawns the backend, and a second reuses it", async () => {
    const { dir, marker, port } = await workspace()
    const config = testConfig(port, marker, 300)
    const lockFile = join(dir, "daemon.lock")

    const daemon = await runDaemon(config, { lockFile, handleSignals: false })
    cleanups.push(() => daemon.close())

    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 200 && !(await probe(url)); i++) await Bun.sleep(50)

    // A real Streamable HTTP MCP handshake, then a tool call.
    const post = async (payload: unknown, sessionId?: string) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }
      if (sessionId) headers["mcp-session-id"] = sessionId
      return fetch(`${url}/mcp/fake`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
    }

    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    })
    expect(init.status).toBe(200)
    const sessionId = init.headers.get("mcp-session-id")
    expect(sessionId).toBeTruthy()

    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId!)

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId!)
    expect(list.status).toBe(200)
    const listBody = await list.text()
    expect(listBody).toContain("decide")

    // Now the child has spawned: this is the first moment a model would load.
    await Bun.sleep(200)
    expect(await markerLines(marker)).toContain("spawned")

    const call = await post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "decide", arguments: {} } },
      sessionId!,
    )
    expect(call.status).toBe(200)
    await Bun.sleep(200)

    const lines = await markerLines(marker)
    // One spawn, two uses. If a second spawn had happened, `spawned` would appear twice,
    // which is exactly the duplicate-model bug this project exists to prevent.
    expect(lines.filter((l) => l === "spawned").length).toBe(1)
    expect(lines.filter((l) => l === "called").length).toBe(1)
  }, 40_000)
})

describe("idle shutdown", () => {
  test("the daemon exits after the quiet window, but not before anything loaded", async () => {
    const { dir, marker, port } = await workspace()
    // Two-second window so the mechanism is observable in a test.
    const config = testConfig(port, marker, 2)
    const lockFile = join(dir, "daemon.lock")

    const daemon = await runDaemon(config, { lockFile, handleSignals: false })
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 200 && !(await probe(url)); i++) await Bun.sleep(50)
    expect(await probe(url)).not.toBeNull()

    // It must survive the first sweep tick despite being idle and cold. A supervisor
    // that fired on "nothing warm" without the "was ever warm" guard would exit here.
    await Bun.sleep(1500)
    expect(await probe(url)).not.toBeNull()

    // Now make it warm by doing a real handshake, then let it go quiet.
    const init = await fetch(`${url}/mcp/fake`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    })
    const sessionId = init.headers.get("mcp-session-id")
    expect(sessionId).toBeTruthy()
    const list = await fetch(`${url}/mcp/fake`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    })
    // Read the body, not just the headers. The MCP transport answers with an SSE
    // stream, so `fetch` resolves as soon as headers are flushed -- which is before
    // the backend has spawned. Waiting on the body is what makes this deterministic.
    expect(await list.text()).toContain("decide")
    expect(await markerLines(marker)).toContain("spawned")

    const health = (await probe(url)) as { anyLocalWarm: boolean }
    expect(health.anyLocalWarm).toBe(true)

    // Past the window with no traffic: the daemon should wind itself down.
    const shutdownDeadline = Date.now() + 15_000
    while (Date.now() < shutdownDeadline && (await probe(url))) await Bun.sleep(200)

    expect(await probe(url)).toBeNull()
    // The daemon shut itself down: `finished` resolves without anyone calling close().
    await daemon.finished
  }, 45_000)
})
