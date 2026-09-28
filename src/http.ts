/**
 * HTTP front: MCP Streamable HTTP in, backend traffic out.
 *
 * The route table is deliberately small:
 *
 *   GET  /health          status, loads nothing, used by the plugin to decide whether
 *                         to start a daemon
 *   POST /mcp/:backend    JSON-RPC, the real endpoint
 *   GET  /mcp/:backend    SSE stream for server-initiated notifications
 *   DELETE /mcp/:backend  end an MCP session
 *
 * One endpoint per backend rather than one multiplexed endpoint, because opencode
 * registers one MCP server per URL and that is also what keeps tool names namespaced:
 * tools from `laya` stay `laya_predict` and cannot collide with a later `rev` backend
 * exposing its own.
 *
 * Built on `node:http` rather than Bun's native `Bun.serve` so the MCP SDK's
 * `StreamableHTTPServerTransport` can be handed the request and response directly. Bun
 * runs `node:http` natively, so this costs nothing and avoids reimplementing session
 * handling, SSE framing, and protocol negotiation.
 *
 * ## The timeout that matters
 *
 * A client's first `initialize` against a cold backend pays the model load, measured at
 * 20-54s here, on top of the backend's own import. opencode's default `mcp.timeout.startup`
 * is 30s, so a cold remote server looks like a startup failure. The plugin raises that
 * timeout when it registers the server; this side just has to not give up first.
 *
 * ## What this module depends on
 *
 * `BackendRoutes`, which is four methods — not the supervisor. Everything else about a
 * backend (how it starts, when it may be stopped, what transport it speaks) is behind
 * that slice, so routing can be tested against a port that is not a supervisor. The
 * previous signature took the concrete `Supervisor` class, which meant the one module
 * that had a real seam never exposed it and every routing test needed a live child
 * process.
 *
 * ## Two front doors, on purpose
 *
 * The JSON endpoints (`/catalog`, `/call`) and the MCP endpoint (`/mcp/:backend`) are the
 * same daemon. They exist because the two have different readers:
 *
 *   - opencode talks to `/catalog` and `/call`, because the plugin can register a tool
 *     directly. Going through MCP to reach a tool opencode can already host natively costs
 *     a protocol layer and puts a server in the user's sidebar per backend, which is
 *     exactly the clutter worth removing.
 *   - Anything else — a script, a benchmark harness, a different client — talks MCP,
 *     which is the interchange format for this class of model and the one laya itself
 *     speaks.
 *
 * The schemas are never hand-written. `/catalog` forwards the backend's own `tools/list`,
 * so the tool definitions opencode sees are the ones the model actually publishes, and a
 * model that changes its surface does not need a matching edit here.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "./config.ts"
import { healthReport } from "./health.ts"
import { describeError } from "./async.ts"
import { logger } from "./log.ts"
import { VERSION } from "./version.ts"

const log = logger("http")

/** Request bodies larger than this are refused rather than buffered. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * The slice of the backend port this module needs.
 *
 * Declared as a `Pick` rather than its own interface so it cannot drift from the real
 * one. Narrower than the full port on purpose: a test for routing should not have to
 * implement the idle watch to satisfy a type it does not use.
 */
export type BackendRoutes = Pick<
  import("./backend/types.ts").BackendPort,
  "names" | "get" | "call" | "snapshot"
>

export interface RunningDaemon {
  server: Server
  port: number
  url: string
  close(): Promise<void>
}

export async function serve(config: Config, backends: BackendRoutes): Promise<RunningDaemon> {
  /** MCP session id -> its transport. The transport owns the Server it is paired with. */
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  /**
   * The signal of the request currently being handled, per transport.
   *
   * A WeakMap rather than one variable, because two sessions can be mid-call at once and
   * a shared variable would hand one session's disconnect to the other session's model
   * call. Keyed on the transport so the lifetime is exactly the session's.
   */
  const inFlight = new WeakMap<StreamableHTTPServerTransport, AbortSignal | undefined>()

  const buildServer = (backendName: string, transport: StreamableHTTPServerTransport): McpServer => {
    const server = new McpServer(
      { name: `onesystem:${backendName}`, version: VERSION },
      { capabilities: { tools: {}, prompts: {}, resources: {} } },
    )

    const prefix = backends.get(backendName).toolPrefix

    // Every handler is a straight forward. The supervisor is what decides whether that
    // costs a model load, so nothing here needs to know about VRAM or cold starts.
    const forward = (method: string) => async (req: { params?: Record<string, unknown> }) => {
      const params = { ...(req.params ?? {}) } as Record<string, unknown>

      // Restore the backend's own prefix on the way in. opencode knows the tool as
      // `predict`; the process only answers to `laya_predict`.
      if (method === "tools/call" && prefix && typeof params.name === "string") {
        params.name = prefix + params.name
      }

      // The client's disconnect rides through, so a caller that gives up does not leave a
      // model call running. It used to be dropped here: the interface declared a signal,
      // the supervisor forwarded it, and this line called `call` with three arguments.
      const result = (await backends.call(backendName, method, params, inFlight.get(transport))) ?? {}

      // And strip it again on the way out, so the catalog opencode caches reads
      // `predict`. Renaming only in one direction would break the other.
      if (method === "tools/list" && prefix) {
        const tools = (result as { tools?: { name?: string }[] }).tools
        if (Array.isArray(tools)) {
          for (const tool of tools) {
            if (typeof tool.name === "string" && tool.name.startsWith(prefix)) {
              tool.name = tool.name.slice(prefix.length)
            }
          }
        }
      }
      return result as never
    }

    server.setRequestHandler(ListToolsRequestSchema, forward("tools/list") as never)
    server.setRequestHandler(CallToolRequestSchema, forward("tools/call") as never)
    server.setRequestHandler(ListPromptsRequestSchema, forward("prompts/list") as never)
    server.setRequestHandler(GetPromptRequestSchema, forward("prompts/get") as never)
    server.setRequestHandler(ListResourcesRequestSchema, forward("resources/list") as never)
    server.setRequestHandler(ReadResourceRequestSchema, forward("resources/read") as never)
    // Advertising the `resources` capability makes opencode ask for templates on every
    // connect. Without this handler it logs "Method not found" once per session per
    // reconnect, which is pure noise from a capability we advertised and did not serve.
    server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      forward("resources/templates/list") as never,
    )

    return server
  }

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, backendName: string, body: unknown) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined
    let transport = sessionId ? sessions.get(sessionId) : undefined

    if (!transport) {
      // First message of a session. The SDK generates and owns the id from here.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, transport!)
          log.debug("session opened", { backend: backendName, id })
        },
      })
      transport.onclose = () => {
        if (transport!.sessionId) sessions.delete(transport!.sessionId)
        log.debug("session closed", { backend: backendName })
      }
      const server = buildServer(backendName, transport)
      await server.connect(transport)
    }

    // Published for the duration of the request so the handlers above can pass the
    // client's disconnect down to the backend, then forgotten either way.
    const client = clientDisconnect(req, res)
    inFlight.set(transport, client.signal)
    try {
      await transport.handleRequest(req, res, body)
    } finally {
      inFlight.delete(transport)
      client.dispose()
    }
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((err) => {
      log.error("unhandled", { error: describeError(err) })
      if (!res.headersSent) {
        const status = httpStatus(err)
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: status === 400 ? "bad_request" : "internal_error", message: describeError(err) }))
      }
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
    res.setHeader("x-onesystem", VERSION)

    if (url.pathname === "/health" && req.method === "GET") {
      const body = JSON.stringify(
        healthReport({ idleShutdownSecs: config.idleShutdownSecs, backends: backends.snapshot().backends }),
      )
      res.writeHead(200, { "content-type": "application/json" })
      res.end(body)
      return
    }

    if (url.pathname === "/catalog" && req.method === "GET") {
      // The tool surface, per backend, straight from the models. For a client that can
      // register tools itself and does not want an MCP server in its UI.
      const backendsOut = await Promise.all(
        backends.names().map(async (name) => {
          const backend = backends.get(name)
          let tools: unknown = []
          let error: string | undefined
          try {
            tools = await backends.call(name, "tools/list", {})
          } catch (err) {
            // One backend that cannot be reached must not hide the others. The plugin
            // registers what it can and reports the rest, rather than registering nothing.
            error = describeError(err)
          }
          return { backend: name, toolPrefix: backend.toolPrefix, tools, error }
        }),
      )
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ backends: backendsOut }))
      return
    }

    if (url.pathname === "/call" && req.method === "POST") {
      const body = (await readJsonBody(req)) as { backend?: string; tool?: string; arguments?: unknown }
      if (typeof body?.backend !== "string" || typeof body.tool !== "string") {
        throw Object.assign(new Error("expected { backend, tool, arguments }"), { status: 400 })
      }
      if (!backends.names().includes(body.backend)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: "unknown_backend",
            message: `no backend named ${body.backend}; configured: ${backends.names().join(", ") || "none"}`,
          }),
        )
        return
      }
      // The caller's disconnect, the same signal the MCP path uses, so a session that
      // gives up does not leave a model call running.
      const result = await backends.call(
        body.backend,
        "tools/call",
        { name: body.tool, arguments: body.arguments ?? {} },
        clientDisconnect(req, res).signal,
      )
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result }))
      return
    }

    const match = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]+)$/)
    if (match) {
      const backendName = match[1]!
      if (!backends.names().includes(backendName)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: "unknown_backend",
            message: `no backend named ${backendName}; configured: ${backends.names().join(", ") || "none"}`,
          }),
        )
        return
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req)
        await handleMcp(req, res, backendName, body)
        return
      }
      // GET and DELETE need the raw stream, so they go through with no parsed body.
      await handleMcp(req, res, backendName, undefined)
      return
    }

    res.writeHead(404, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        error: "not_found",
        message: "GET /health, GET /catalog, POST /call, or POST /mcp/:backend",
        backends: backends.names(),
      }),
    )
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(config.port, config.host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === "object" && address ? address.port : config.port
  const url = daemonUrl(config.host, port)
  log.info("listening", { url, backends: backends.names() })

  return {
    server,
    port,
    url,
    close: async () => {
      for (const transport of sessions.values()) {
        await transport.close().catch(() => {})
      }
      sessions.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** The one place a daemon's address is assembled. See `daemonUrl` in config.ts. */
function daemonUrl(host: string, port: number): string {
  return `http://${host}:${port}`
}

/**
 * A signal that fires when the client goes away mid-request.
 *
 * Not `req.signal`, which is the obvious choice and is wrong here. A request's own signal
 * aborts when the *request* is done — and a POST with a body is done the moment we have
 * read it, which is before the handler runs. Wiring that through aborted every single
 * tool call. What we want is the client hanging up before the response finished, which
 * lives on the response: `close` with nothing written means the peer went away.
 */
function clientDisconnect(req: IncomingMessage, res: ServerResponse): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  const onAborted = () => controller.abort()
  res.on("close", onClose)
  req.on("aborted", onAborted)
  return {
    signal: controller.signal,
    dispose: () => {
      res.off("close", onClose)
      req.off("aborted", onAborted)
    },
  }
}

/**
 * A request error that already knows its status.
 *
 * `readJsonBody` used to attach `{status: 400}` and the one catch site ignored it and
 * wrote 500 for everything, so every malformed body came back as `internal_error`.
 */
function httpStatus(err: unknown): number {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === "number" && status >= 400 && status <= 599 ? status : 500
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.byteLength
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`), { status: 413 })
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw Object.assign(new Error(`invalid JSON body: ${(err as Error).message}`), { status: 400 })
  }
}
