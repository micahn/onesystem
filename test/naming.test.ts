/**
 * Verify both directions of MCP tool renaming: list stripped names, accept those
 * names in calls, and restore the backend's prefix before forwarding.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validate, type Config, type ConfiguredBackend } from "../src/config.ts"
import { registrations } from "../src/naming.ts"
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
          startupTimeoutSecs: 20,
          // The declared surface is bare; `toolPrefix` puts the wire name back, which is
          // what the catalog reports and what `/call` must carry.
          tools: ["decide"],
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
  // Literals, not `validate` output.
  //
  // These four tests used to call `validate({ backends: ... })` three times over, purely to
  // obtain a `Config` literal to hand to `registrations()`. Which means the naming rules
  // were never being tested -- the validator was, incidentally, on the way to them, and a
  // naming bug and a validation bug looked identical from here. `registrations` takes the
  // `backends` map now, so a rule is a rule and a literal is enough.
  const a: ConfiguredBackend = { transport: "stdio-mcp", command: ["x"], tools: ["predict"] }
  const b: ConfiguredBackend = { transport: "stdio-mcp", command: ["x"], tools: ["predict"] }

  test("a single enabled backend gets the clean name", () => {
    expect(registrations({ a, b: { ...b, enabled: false } })).toEqual([
      { backend: "a", serverName: "onesystem", toolPrefix: undefined, transport: "stdio-mcp" },
    ])
  })

  test("several backends cannot both claim `onesystem`", () => {
    const names = registrations({ a, b }).map((r) => r.serverName)
    expect(names).toEqual(["onesystem-a", "onesystem-b"])
    expect(new Set(names).size).toBe(2)
  })

  test("an explicit serverName wins", () => {
    expect(registrations({ a: { ...a, serverName: "decisions" }, b: { ...b, enabled: false } })[0]!.serverName).toBe(
      "decisions",
    )
  })

  test("toolPrefix is carried through", () => {
    expect(registrations({ a: { ...a, toolPrefix: "laya_" }, b: { ...b, enabled: false } })[0]!.toolPrefix).toBe(
      "laya_",
    )
  })

  test("a disabled backend is not registered at all", () => {
    // `enabled: false` rather than absent, since absent means on.
    expect(registrations({ a, b: { ...b, enabled: false } }).map((r) => r.backend)).toEqual(["a"])
  })

  test("no backends is an empty list, not a crash", () => {
    expect(registrations({})).toEqual([])
  })

  test("validate produces what registrations will read", () => {
    // The drift guard, and the reason the two are tested separately rather than one
    // through the other. `registrations` reads the declared `backends` map; `validate` is
    // what fills that map in. If the validator ever stopped carrying a field through —
    // `serverName`, `toolPrefix`, `enabled` — the naming rules would keep passing on
    // literals while production quietly got a different answer. This is the assertion that
    // notices, and it is the one the old test was accidentally close to without being.
    const raw: { backends: Record<string, ConfiguredBackend> } = {
      backends: {
        a: { transport: "stdio-mcp", command: ["x"], tools: ["predict"], serverName: "decisions", toolPrefix: "laya_" },
        b: { transport: "stdio-mcp", command: ["x"], tools: ["predict"] },
        c: { transport: "stdio-mcp", command: ["x"], tools: ["predict"], enabled: false },
      },
    }
    const config = validate(raw, "test")
    expect(registrations(config.backends)).toEqual(registrations(raw.backends))
    // And specifically the three fields, so a failure says which one drifted.
    expect(config.backends.a!.serverName).toBe("decisions")
    expect(config.backends.a!.toolPrefix).toBe("laya_")
    expect(config.backends.c!.enabled).toBe(false)
  })
})
