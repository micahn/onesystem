/**
 * Tool naming across the bridge.
 *
 * The point of `toolPrefix` is that the surface reads `onesystem.predict` rather than
 * `onesystem.laya_predict`. That is a rename in both directions, and a rename done in
 * only one direction is worse than no rename at all: the catalog would advertise a name
 * the backend cannot answer to, and every call would fail with "unknown tool" against a
 * server that looked perfectly healthy.
 *
 * So this checks all three halves: the catalog comes back stripped, a call using the
 * stripped name reaches the backend, and the backend really saw its own prefixed name.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validate, registrations, type Config } from "../src/config.ts"
import { runDaemon, probe } from "../src/daemon.ts"

const cleanups: (() => Promise<void>)[] = []
const dirs: string[] = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {})
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

function prefixedConfig(port: number, marker: string, toolPrefix?: string): Config {
  return validate(
    {
      port,
      idleShutdownSecs: 300,
      idleSweepSecs: 1,
      requestTimeoutSecs: 20,
      backends: {
        fake: {
          transport: "stdio-mcp",
          command: [process.execPath, new URL("./fixtures/fake-mcp.ts", import.meta.url).pathname],
          env: { FAKE_MCP_MARKER: marker, FAKE_MCP_TOOL: "fake_decide" },
          toolPrefix,
          startupTimeoutSecs: 30,
        },
      },
    },
    "test",
  )
}

async function setup(prefix?: string) {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-name-"))
  dirs.push(dir)
  const port = 8000 + Math.floor(Math.random() * 900)
  const config = prefixedConfig(port, join(dir, "m.log"), prefix)
  const daemon = await runDaemon(config, { lockFile: join(dir, "d.lock"), handleSignals: false })
  cleanups.push(() => daemon.close())
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 200 && !(await probe(url)); i++) await Bun.sleep(50)
  return { url, daemon }
}

/** Minimal MCP handshake, returning the session id and a `post` bound to it. */
async function connect(url: string) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" }
  const init = await fetch(`${url}/mcp/fake`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  })
  const sessionId = init.headers.get("mcp-session-id")!
  const post = async (payload: unknown) => {
    const res = await fetch(`${url}/mcp/fake`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify(payload),
    })
    return (await res.text()).replace(/\\/g, "")
  }
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  return { post, sessionId }
}

describe("tool naming", () => {
  test("toolPrefix strips on the catalog and is restored on the call", async () => {
    const { url } = await setup("fake_")
    const { post } = await connect(url)

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    expect(list).toContain('"name":"decide"')
    expect(list).not.toContain("fake_decide")

    // The whole point: the caller uses the short name.
    const call = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "decide", arguments: {} },
    })
    expect(call).toContain("ok:fake_decide")
    expect(call).not.toContain("unknown tool")
  }, 40_000)

  test("without a toolPrefix names pass through untouched", async () => {
    const { url } = await setup(undefined)
    const { post } = await connect(url)

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    expect(list).toContain('"name":"fake_decide"')
  }, 40_000)
})

describe("server naming", () => {
  const base = {
    a: { transport: "stdio-mcp", command: ["x"] },
    b: { transport: "stdio-mcp", command: ["x"] },
  }

  test("a single enabled backend gets the clean name", () => {
    const config = validate({ backends: { a: base.a, b: { ...base.b, enabled: false } } }, "test")
    expect(registrations(config)).toEqual([
      { backend: "a", serverName: "onesystem", toolPrefix: undefined, transport: "stdio-mcp" },
    ])
  })

  test("several backends cannot both claim `onesystem`", () => {
    const config = validate({ backends: base }, "test")
    const names = registrations(config).map((r) => r.serverName)
    expect(names).toEqual(["onesystem-a", "onesystem-b"])
    expect(new Set(names).size).toBe(2)
  })

  test("an explicit serverName wins", () => {
    const config = validate(
      { backends: { a: { ...base.a, serverName: "decisions" }, b: { ...base.b, enabled: false } } },
      "test",
    )
    expect(registrations(config)[0]!.serverName).toBe("decisions")
  })

  test("toolPrefix is carried through", () => {
    const config = validate(
      { backends: { a: { ...base.a, toolPrefix: "laya_" }, b: { ...base.b, enabled: false } } },
      "test",
    )
    expect(registrations(config)[0]!.toolPrefix).toBe("laya_")
  })
})
