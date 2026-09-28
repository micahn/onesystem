/**
 * HTTP API over BackendRoutes:
 *   GET /health           status without loading models
 *   GET /catalog          declared tools without starting backends
 *   POST /call            native plugin tool calls
 *   POST /mcp/:backend    MCP JSON-RPC for other clients
 *   GET /mcp/:backend     MCP SSE notifications
 *   DELETE /mcp/:backend  end an MCP session
 *
 * node:http supplies the request/response objects the MCP SDK needs.
 * MCP tools/list reaches the backend and can start it; /catalog must remain local.
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
import { daemonUrl } from "./paths.ts"
import { healthReport } from "./health.ts"
import { run } from "./subprocess.ts"
import { attribute, VramReader } from "./vram.ts"
import { modelFor } from "./models.ts"
import { describeError } from "./async.ts"
import { logger } from "./log.ts"
import { VERSION } from "./version.ts"

const log = logger("http")

/** Request bodies larger than this are refused rather than buffered. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Only the BackendPort methods HTTP uses. Pick keeps their types in sync.
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
  const vram = new VramReader(run)
  /** MCP session id -> its transport. The transport owns the Server it is paired with. */
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  /**
    * Current request signal per transport so concurrent sessions do not share cancellation.
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
      if (method === "tools/call" && typeof params.name === "string") {
        params.name = wireName(params.name, prefix)
      }

      // Forward disconnects so abandoned calls can release backend resources.
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
    // The advertised resources capability includes template listing.
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
      // The card is read here because this is the one endpoint the plugin polls, and the
      // sample is cached: a footer, a card and a dialog can all ask inside one interval,
      // and the driver is two subprocesses.
      const statuses = backends.snapshot().backends
      const owned = new Map(statuses.map((b) => [b.name, backends.get(b.name).ownedPids()]))
      const sample = await vram.sample([...owned.values()].flat())
      const body = JSON.stringify(
        healthReport({
          idleShutdownSecs: config.idleShutdownSecs,
          backends: statuses,
          gpu: attribute(sample, owned),
        }),
      )
      res.writeHead(200, { "content-type": "application/json" })
      res.end(body)
      return
    }

    if (url.pathname === "/catalog" && req.method === "GET") {
      // Read declared tools without calling a backend. Include wire prefixes for
      // /call; the plugin strips them only from displayed names.
      const backendsOut = backends.names().map((backendName) => {
        const backend = backends.get(backendName)
        const prefix = backend.toolPrefix ?? ""
        const schemas = modelFor(backendName)?.toolSchemas ?? {}
        return {
          backend: backendName,
          toolPrefix: backend.toolPrefix,
          tools: {
            tools: backend.tools.map((tool) => ({
              name: prefix + tool,
              // A tool the model describes says so, and an undescribed one stays open:
              // either way the backend validates its own arguments.
              description:
                `${backendName} ${tool}. Forwards its arguments to ${backendName} unchanged; ` +
                `see the backend's own tools/list for the authoritative schema.`,
              inputSchema: { type: "object", additionalProperties: true, ...schemas[tool] },
            })),
          },
        }
      })
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
      const backend = backends.get(body.backend)
      // /mcp/:backend lists the bare name and /catalog advertises the prefixed one, so
      // accept either: the caller should not have to know which endpoint it read from.
      const name = wireName(body.tool, backend.toolPrefix)
      // The caller's disconnect, the same signal the MCP path uses, so a session that
      // gives up does not leave a model call running.
      let result: unknown
      try {
        result = await backends.call(
          body.backend,
          "tools/call",
          { name, arguments: body.arguments ?? {} },
          clientDisconnect(req, res).signal,
        )
      } catch (err) {
        // Answer an unrecognized name with the names the backend does take. The declared
        // list is consulted only here, so a stale entry still reaches the backend.
        const wireNames = backend.tools.map((tool) => wireName(tool, backend.toolPrefix))
        if (wireNames.includes(name)) throw err
        res.writeHead(404, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: "unknown_tool",
            message:
              `${body.backend} has no tool "${body.tool}"; it takes ` +
              `${wireNames.map((n) => `"${n}"`).join(", ") || "nothing"}`,
          }),
        )
        return
      }
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

/**
 * The name the backend process answers to. Both HTTP surfaces serve tools under
 * this name and one under the bare name, so both must accept either form.
 */
function wireName(tool: string, prefix: string | undefined): string {
  return prefix && !tool.startsWith(prefix) ? prefix + tool : tool
}

/**
 * Abort when the client disconnects before the response ends. Reading the full
 * POST body is normal and must not cancel the backend call that follows.
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
 * Preserve valid HTTP error statuses; use 500 for other errors.
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
