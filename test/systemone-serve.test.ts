/**
 * The serve transport: spawn a `/v1/systemone` service, wait for it to be ready, forward,
 * and let go of it.
 *
 * The service is faked rather than run. What is worth testing here is the lifecycle, and
 * that is the part a real service would make slow and awkward: that readiness means
 * `status: "ready"` rather than any 200, that a process which dies before ready fails the
 * start instead of leaving a poll running against nothing, and that a quiesce during a
 * pending start does not publish a process afterwards.
 */

import { describe, expect, test } from "bun:test"
import { SystemOneServeBackend } from "../src/backend/systemone-serve.ts"
import type { ServeBackend } from "../src/backend/spec.ts"
import type { BackendError } from "../src/backend/types.ts"

const spec = (over: Partial<ServeBackend> = {}): ServeBackend => ({
  transport: "systemone-serve",
  command: ["/bin/true", "serve"],
  baseUrl: "http://127.0.0.1:8017",
  model: "rizzo-latest",
  tools: ["predict"],
  startupTimeoutSecs: 5,
  ...over,
})

const call = (backend: SystemOneServeBackend, args: unknown) =>
  backend.call({ method: "tools/call", params: { name: "predict", arguments: args }, timeoutMs: 5000 })

/** A health route that reports ready, and a /v1/systemone that echoes what it was sent. */
function fakeService(ready = true) {
  const seen: { url: string; body: any }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/health")) {
      return Response.json({ status: ready ? "ready" : "loading" })
    }
    seen.push({ url, body: JSON.parse(String(init.body)) })
    return Response.json({ answers: { cause: { type: "choice", choice: "pool" } } })
  }
  return { fetch, seen }
}

const longRunning = ["/bin/sleep", "30"]

describe("readiness", () => {
  test("a 200 that is not ready is still starting", async () => {
    // These services bind their port before the weights are loaded, so a 200 means the
    // socket is open, not that the model can answer. Polling to 200 would publish a
    // backend whose first call 500s.
    const { fetch, seen } = fakeService(false)
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning, startupTimeoutSecs: 2 }), { fetch })
    await expect(call(backend, { state: "s", questions: {} })).rejects.toThrow(/failed to start/)
    expect(seen).toHaveLength(0)
    expect(backend.state).toBe("failed")
    await backend.quiesce()
  })

  test("ready is published, and the tools are declared without starting anything", async () => {
    const { fetch, seen } = fakeService()
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning }), { fetch })
    // Reading tools must not spawn: /catalog is answered while every backend is cold.
    expect(backend.tools).toEqual(["predict"])
    expect(backend.state).toBe("cold")

    const result = (await call(backend, { state: "s", questions: { q: { type: "choice" } } })) as any
    expect(backend.state).toBe("warm")
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content[0].text)).toEqual({ answers: { cause: { type: "choice", choice: "pool" } } })
    // The raw payload is kept too, so a distribution is usable without re-parsing text.
    expect(result.structuredContent.answers.cause.choice).toBe("pool")
    expect(seen).toHaveLength(1)
    await backend.quiesce()
  })

  test("the model name from config is what gets sent", async () => {
    // The service selects by name and has no default, so this is the entire shape change.
    const { fetch, seen } = fakeService()
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning, model: "rizzo-flow-4b-q8_0" }), { fetch })
    await call(backend, { state: "the state", questions: { q: { type: "noul" } } })
    expect(seen[0]!.body).toEqual({
      model: "rizzo-flow-4b-q8_0",
      state: "the state",
      questions: { q: { type: "noul" } },
    })
    await backend.quiesce()
  })

  test("a trailing slash on baseUrl does not double up in the path", async () => {
    const { fetch, seen } = fakeService()
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning, baseUrl: "http://127.0.0.1:8017/" }), { fetch })
    await call(backend, { state: "s", questions: {} })
    expect(seen[0]!.url).toBe("http://127.0.0.1:8017/v1/systemone")
    await backend.quiesce()
  })
})

describe("what the transport refuses", () => {
  test("a call with no state or no questions is rejected before anything is spawned", async () => {
    const { fetch, seen } = fakeService()
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning }), { fetch })
    await expect(call(backend, { questions: {} })).rejects.toThrow(/state/)
    await expect(call(backend, { state: "s" })).rejects.toThrow(/questions/)
    expect(seen).toHaveLength(0)
    expect(backend.state).toBe("cold")
  })

  test("a method this transport cannot serve is not a call", async () => {
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning }), { fetch: fakeService().fetch })
    await expect(
      backend.call({ method: "resources/list", params: {}, timeoutMs: 1000 }),
    ).rejects.toThrow(/not supported over the serve bridge/)
    // Never started, and so never counted as a call.
    expect(backend.state).toBe("cold")
    expect(backend.describe().calls).toBe(0)
  })

  test("a service error is passed through rather than flattened to a status", async () => {
    // A 422 here carries a per-field detail, which is the only useful thing to show.
    const fetch = async (url: string) => {
      if (url.endsWith("/health")) return Response.json({ status: "ready" })
      return new Response(JSON.stringify({ detail: [{ loc: ["body", "model"] }] }), { status: 422 })
    }
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning }), { fetch })
    await expect(call(backend, { state: "s", questions: {} })).rejects.toThrow(/422/)
    await expect(call(backend, { state: "s", questions: {} })).rejects.toThrow(/body.*model/)
    await backend.quiesce()
  })
})

describe("the process onesystem owns", () => {
  test("it is local, so the idle sweep counts it", () => {
    // A served model holds VRAM, so unlike systemone-http it must be stoppable by idle.
    const backend = new SystemOneServeBackend("r", spec(), { fetch: fakeService().fetch })
    expect(backend.local).toBe(true)
    expect(backend.describe().local).toBe(true)
  })

  test("quiesce waits for a pending start rather than publishing afterwards", async () => {
    // The bug this shape invites: start resolves after quiesce returns, leaving a process
    // nobody is holding a handle to. The generation counter is what prevents it.
    const { fetch } = fakeService()
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning }), { fetch })
    const starting = call(backend, { state: "s", questions: {} }).catch(() => undefined)
    await backend.quiesce()
    await starting
    expect(backend.state).toBe("cold")
    // Nothing is still listening once quiesce has returned.
    expect(backend.state).not.toBe("warm")
  })

  test("quiesce on a cold backend is a no-op and does not fail", async () => {
    const backend = new SystemOneServeBackend("r", spec(), { fetch: fakeService().fetch })
    await backend.quiesce()
    expect(backend.state).toBe("cold")
  })

  test("a process that dies before ready fails the start, not the poll", async () => {
    const fetch = async (url: string) => {
      if (url.endsWith("/health")) return new Response("nope", { status: 503 })
      return new Response("", { status: 500 })
    }
    const backend = new SystemOneServeBackend(
      "r",
      spec({ command: ["/bin/sh", "-c", "exit 3"], startupTimeoutSecs: 5 }),
      { fetch },
    )
    const err = (await call(backend, { state: "s", questions: {} }).catch((e) => e)) as BackendError
    expect(err.message).toMatch(/failed to start/)
    expect(backend.state).toBe("failed")
    await backend.quiesce()
  })

  test("a command that does not exist fails the start with the reason", async () => {
    const backend = new SystemOneServeBackend(
      "r",
      spec({ command: ["/definitely/not/here", "serve"], startupTimeoutSecs: 5 }),
      {
        fetch: fakeService().fetch,
        spawn: (() => {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
        }) as never,
      },
    )
    // A binary that cannot be executed leaves pid undefined and never emits "exit", so
    // without this the health poll would keep asking a service that does not exist and
    // time out for a reason that has nothing to do with startup.
    // The wording differs by runtime; what matters is that it names the program and fails
    // the start rather than polling a service that does not exist.
    await expect(call(backend, { state: "s", questions: {} })).rejects.toThrow(/could not execute/)
    await expect(call(backend, { state: "s", questions: {} })).rejects.toThrow(
      /\/definitely\/not\/here/,
    )
    expect(backend.state).toBe("failed")
    await backend.quiesce()
  })
})

describe("accounting", () => {
  test("calls are counted and a cold start is inside the measured duration", async () => {
    const { fetch } = fakeService()
    let clock = 0
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning }), { fetch, now: () => clock })
    await call(backend, { state: "s", questions: {} })
    clock += 40
    await call(backend, { state: "s", questions: {} })
    const d = backend.describe()
    expect(d.calls).toBe(2)
    expect(d.errors).toBe(0)
    expect(d.idleMs).toBe(0)
    // Usage accounting comes free: the ledger unwraps content[0].text and counts the
    // answers map, so a served backend reports usage exactly as an MCP one does. One
    // question per call, two calls.
    expect(d.answered).toBe(2)
    expect(d.byType).toEqual({ choice: 2 })
  })

  test("a failed call is counted as an error, not swallowed", async () => {
    let healthy = true
    const fetch = async (url: string) => {
      if (url.endsWith("/health")) return Response.json({ status: "ready" })
      if (!healthy) return new Response("boom", { status: 500 })
      return Response.json({ answers: {} })
    }
    const backend = new SystemOneServeBackend("r", spec({ command: longRunning }), { fetch })
    await call(backend, { state: "s", questions: {} })
    healthy = false
    await expect(call(backend, { state: "s", questions: {} })).rejects.toThrow()
    expect(backend.describe().errors).toBe(1)
    await backend.quiesce()
  })

  test("the tool prefix is read from config, like every other transport", () => {
    const backend = new SystemOneServeBackend("r", spec({ toolPrefix: "rizzo_" }), { fetch: fakeService().fetch })
    expect(backend.toolPrefix).toBe("rizzo_")
  })
})
