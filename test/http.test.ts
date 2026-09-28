/**
 * Exercise HTTP routes through a small BackendPort fake without starting a model.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { serve, type BackendRoutes, type RunningDaemon } from "../src/http.ts"
import { validate, type Config } from "../src/config.ts"
import { BackendError, type Backend, type BackendStatus } from "../src/backend/types.ts"
import { FakeBackend } from "./fixtures/fake-backend.ts"

const running: RunningDaemon[] = []

afterEach(async () => {
  while (running.length) await running.pop()!.close().catch(() => {})
})

/**
 * Listen on a kernel-selected port and use the address returned by the listener.
 */
async function listen(backends: BackendRoutes): Promise<{ daemon: RunningDaemon; url: string }> {
  const config = validate({ port: 0, idleShutdownSecs: 300, idleSweepSecs: 5 }, "test")
  const daemon = await serve(config, backends)
  running.push(daemon)
  return { daemon, url: `http://127.0.0.1:${daemon.port}` }
}

/**
 * The four methods `serve` declares it needs, over a set of named backends.
 *
 * Deliberately hand-rolled rather than reusing `Supervisor`: this is what a caller that
 * is not the daemon has to write, and it staying this small is the point.
 */
function portOf(backends: Record<string, Backend>): BackendRoutes {
  const entries = Object.entries(backends)
  return {
    names: () => entries.map(([name]) => name),
    get: (name) => {
      const found = backends[name]
      if (!found) throw new BackendError(name, `unknown backend; configured: ${entries.map(([n]) => n).join(", ")}`)
      return found
    },
    // The signal is forwarded, because forwarding it is the whole subject of one of the
    // tests below. A stand-in port that quietly dropped it would make that test pass
    // against the stand-in rather than against the code.
    call: async (name, method, params, signal) => {
      const backend = backends[name]
      if (!backend) throw new BackendError(name, "unknown backend")
      return backend.call({ method, params, signal })
    },
    snapshot: () => ({ backends: entries.map(([, b]) => b.describe()) }),
  }
}

/** Poll until a condition holds, so a test never depends on a fixed sleep. */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await Bun.sleep(20)
  }
  throw new Error("condition not met within timeout")
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  })
}

/** Drive a full MCP handshake, so tests exercise the real protocol path. */
async function session(url: string, backendName: string) {
  const init = await post(`${url}/mcp/${backendName}`, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  })
  const id = init.headers.get("mcp-session-id")
  expect(id).toBeTruthy()
  await init.text()
  return {
    id: id!,
    call: (method: string, params: unknown = {}, extra: Record<string, string> = {}) =>
      post(`${url}/mcp/${backendName}`, { jsonrpc: "2.0", id: 2, method, params }, { "mcp-session-id": id!, ...extra })
        .then((r) => r.text()),
  }
}

describe("routing", () => {
  test("an unknown backend is a 404 naming the ones that exist", async () => {
    const { url } = await listen(portOf({ real: new FakeBackend({ name: "real" }) }))
    const res = await fetch(`${url}/mcp/nope`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe("unknown_backend")
    expect(body.message).toContain("real")
  })

  test("an unknown path is a 404 that lists the backends", async () => {
    const { url } = await listen(portOf({ real: new FakeBackend({ name: "real" }) }))
    const res = await fetch(`${url}/nope`)
    expect(res.status).toBe(404)
    expect((await res.json()) as { backends: string[] }).toMatchObject({ backends: ["real"] })
  })

  test("a backend name with a slash in it is not a backend", async () => {
    // The route regex is `[A-Za-z0-9_-]+`, so this cannot reach `names()` at all rather
    // than reaching it with something it was never meant to see.
    const { url } = await listen(portOf({ real: new FakeBackend() }))
    expect((await fetch(`${url}/mcp/../../etc/passwd`)).status).toBe(404)
  })

  test("a malformed body is a 400, not a 500", async () => {
    // The catch site used to hardcode 500 for everything, so a client's own typo came back
    // as `internal_error` and pointed at the daemon instead of at the request.
    const { url } = await listen(portOf({ real: new FakeBackend() }))
    const res = await fetch(`${url}/mcp/real`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: "{not json",
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: "bad_request" })
  })
})

describe("health", () => {
  test("reports the shape the readers expect, from the port's own snapshot", async () => {
    const fake = new FakeBackend({ name: "real" })
    fake.setState("warm")
    const { url } = await listen(portOf({ real: fake }))

    const report = (await (await fetch(`${url}/health`)).json()) as {
      status: string
      pid: number
      anyLocalWarm: boolean
      backends: BackendStatus[]
    }
    expect(report.status).toBe("ok")
    expect(report.pid).toBe(process.pid)
    expect(report.anyLocalWarm).toBe(true)
    expect(report.backends[0]).toMatchObject({ name: "real", state: "warm", local: true })
  })

  test("a remote backend is reported but never counts as locally warm", async () => {
    const remote = new FakeBackend({ name: "rev", transport: "systemone-http", local: false })
    remote.setState("warm")
    const { url } = await listen(portOf({ rev: remote }))

    const report = (await (await fetch(`${url}/health`)).json()) as { anyLocalWarm: boolean }
    // If this were true, the daemon would never decide nothing is warm and would never
    // exit, for as long as a remote backend is configured.
    expect(report.anyLocalWarm).toBe(false)
  })
})

describe("tool naming across the bridge", () => {
  test("a prefix is stripped from the catalog and restored on the call", async () => {
    const fake = new FakeBackend({
      name: "laya",
      toolPrefix: "laya_",
      tools: [{ name: "laya_predict" }, { name: "laya_status" }],
    })
    const { url } = await listen(portOf({ laya: fake }))
    const mcp = await session(url, "laya")

    // Out: opencode must see `predict`, not `laya_predict`.
    expect(await mcp.call("tools/list")).toContain('"name":"predict"')
    expect(await mcp.call("tools/list")).not.toContain("laya_predict")

    // In: and the process must be asked for `laya_predict` again.
    await mcp.call("tools/call", { name: "predict" })
    expect(fake.calls.at(-1)?.params?.name).toBe("laya_predict")
  })

  test("without a prefix, names pass through untouched in both directions", async () => {
    const fake = new FakeBackend({ name: "raw", tools: [{ name: "decide" }] })
    const { url } = await listen(portOf({ raw: fake }))
    const mcp = await session(url, "raw")

    expect(await mcp.call("tools/list")).toContain('"name":"decide"')
    await mcp.call("tools/call", { name: "decide" })
    expect(fake.calls.at(-1)?.params?.name).toBe("decide")
  })

  test("POST /call takes a bare name, the way /mcp/:backend lists it", async () => {
    // The reported failure: a client read `predict` from /mcp/laya and posted it to
    // /call, which forwarded the name verbatim and got back `Unknown tool: predict`.
    const fake = new FakeBackend({
      name: "laya",
      toolPrefix: "laya_",
      tools: [{ name: "laya_predict" }],
    })
    const { url } = await listen(portOf({ laya: fake }))

    const res = await post(`${url}/call`, { backend: "laya", tool: "predict", arguments: { state: {} } })
    expect(res.status).toBe(200)
    expect(fake.calls.at(-1)?.params?.name).toBe("laya_predict")
  })

  test("POST /call still takes the prefixed name /catalog advertises", async () => {
    const fake = new FakeBackend({
      name: "laya",
      toolPrefix: "laya_",
      tools: [{ name: "laya_predict" }],
    })
    const { url } = await listen(portOf({ laya: fake }))

    await post(`${url}/call`, { backend: "laya", tool: "laya_predict", arguments: {} })
    expect(fake.calls.at(-1)?.params?.name).toBe("laya_predict")
  })

  test("POST /call passes an unprefixed backend's name through untouched", async () => {
    const fake = new FakeBackend({ name: "raw", tools: [{ name: "decide" }] })
    const { url } = await listen(portOf({ raw: fake }))

    await post(`${url}/call`, { backend: "raw", tool: "decide", arguments: {} })
    expect(fake.calls.at(-1)?.params?.name).toBe("decide")
  })

  test("a tool the backend does not have is a 404 naming the ones it does", async () => {
    // `Unknown tool: predict` names the name the client sent and not the one the
    // process answers to, so the caller cannot tell a typo from a naming mismatch.
    const fake = new FakeBackend({
      name: "laya",
      toolPrefix: "laya_",
      tools: [{ name: "laya_predict" }, { name: "laya_status" }],
      fail: new Error("Unknown tool: nope"),
    })
    const { url } = await listen(portOf({ laya: fake }))

    const res = await post(`${url}/call`, { backend: "laya", tool: "nope", arguments: {} })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe("unknown_tool")
    expect(body.message).toContain('"laya_predict"')
    expect(body.message).toContain('"laya_status"')
  })

  test("a declared tool that fails is the backend's error, not a naming complaint", async () => {
    // The declared list is consulted only after a failure, so a stale entry still
    // reaches the backend and its own error is what the caller sees.
    const fake = new FakeBackend({
      name: "laya",
      toolPrefix: "laya_",
      tools: [{ name: "laya_predict" }],
      fail: new Error("out of memory"),
    })
    const { url } = await listen(portOf({ laya: fake }))

    const res = await post(`${url}/call`, { backend: "laya", tool: "predict", arguments: {} })
    expect(res.status).toBe(500)
    expect(((await res.json()) as { message: string }).message).toContain("out of memory")
  })
})

describe("catalog schemas", () => {
  const schemasOf = async (url: string, backend: string) => {
    const catalog = (await (await fetch(`${url}/catalog`)).json()) as {
      backends: { backend: string; tools: { tools: { name: string; inputSchema: unknown }[] } }[]
    }
    return Object.fromEntries(
      catalog.backends.find((b) => b.backend === backend)!.tools.tools.map((t) => [t.name, t.inputSchema]),
    )
  }

  test("laya and julia advertise different state, which is what they accept", async () => {
    // The reported consequence of an untyped catalog: the same structured state works
    // against laya and is rejected by julia, with nothing in the catalog saying so.
    const { url } = await listen(
      portOf({
        laya: new FakeBackend({ name: "laya", tools: [{ name: "predict" }] }),
        julia: new FakeBackend({ name: "julia", tools: [{ name: "predict" }] }),
      }),
    )

    const laya = (await schemasOf(url, "laya")).predict as { properties: { state: { type: unknown } } }
    const julia = (await schemasOf(url, "julia")).predict as { properties: { state: { type: unknown } } }
    expect(laya.properties.state.type).toContain("object")
    expect(julia.properties.state.type).toBe("string")
  })

  test("a tool the model does not describe stays an open object", async () => {
    const { url } = await listen(portOf({ laya: new FakeBackend({ name: "laya", tools: [{ name: "preset" }] }) }))
    expect((await schemasOf(url, "laya")).preset).toEqual({ type: "object", additionalProperties: true })
  })

  test("a backend with no matching ModelSpec is served, and calls nothing", async () => {
    const fake = new FakeBackend({ name: "rev", tools: [{ name: "predict" }] })
    const { url } = await listen(portOf({ rev: fake }))

    expect((await schemasOf(url, "rev")).predict).toEqual({ type: "object", additionalProperties: true })
    // /catalog stays local: a real tools/list here is the cold load the catalog exists to avoid.
    expect(fake.calls).toEqual([])
  })
})

describe("client disconnect", () => {
  // The signal path used to be declared in the interface, threaded through the supervisor,
  // and then never populated: `http.ts` called `call` with three arguments. So a client
  // that gave up left a model call running with nothing able to cancel it, and `inflight`
  // never returned to zero, which stops the idle sweep from ever reaping that backend.
  test("an abandoned tool call hands the backend a live signal", async () => {
    let sawSignal: AbortSignal | undefined
    const hanging = new FakeBackend({ name: "slow" })
    hanging.call = async (ctx) => {
      sawSignal = ctx.signal
      return new Promise(() => {})
    }

    const { url } = await listen(portOf({ slow: hanging }))
    const mcp = await session(url, "slow")

    const controller = new AbortController()
    const pending = fetch(`${url}/mcp/slow`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": mcp.id,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "slow_call" } }),
      signal: controller.signal,
    }).then((r) => r.text())
    void pending.catch(() => {})

    // Wait for the call to actually reach the backend before hanging up on it.
    await waitFor(() => sawSignal !== undefined)
    controller.abort()

    // The signal reached the backend, and it is the one that fires on the disconnect.
    expect(sawSignal).toBeInstanceOf(AbortSignal)
    await waitFor(() => sawSignal!.aborted)
  }, 10_000)
})
