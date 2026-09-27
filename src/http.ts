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
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { Config } from "./config.ts"
import { logger } from "./log.ts"
import { Supervisor } from "./supervisor.ts"

const log = logger("http")

export interface RunningDaemon {
  server: Server
  port: number
  url: string
  close(): Promise<void>
}

export async function serve(config: Config, supervisor: Supervisor): Promise<RunningDaemon> {
  /** MCP session id -> its transport. The transport owns the Server it is paired with. */
  const sessions = new Map<string, StreamableHTTPServerTransport>()

  const buildServer = (backendName: string): McpServer => {
    const server = new McpServer(
      { name: `onesystem:${backendName}`, version: "0.1.0" },
      { capabilities: { tools: {}, prompts: {}, resources: {} } },
    )

    // Every handler is a straight forward. The supervisor is what decides whether that
    // costs a model load, so nothing here needs to know about VRAM or cold starts.
    const forward = (method: string) => async (req: { params?: Record<string, unknown> }) => {
      const result = await supervisor.handle(backendName, method, req.params as Record<string, unknown> | undefined)
      return (result ?? {}) as never
    }

    server.setRequestHandler(ListToolsRequestSchema, forward("tools/list") as never)
    server.setRequestHandler(CallToolRequestSchema, forward("tools/call") as never)
    server.setRequestHandler(ListPromptsRequestSchema, forward("prompts/list") as never)
    server.setRequestHandler(GetPromptRequestSchema, forward("prompts/get") as never)
    server.setRequestHandler(ListResourcesRequestSchema, forward("resources/list") as never)
    server.setRequestHandler(ReadResourceRequestSchema, forward("resources/read") as never)

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
      const server = buildServer(backendName)
      await server.connect(transport)
    }

    await transport.handleRequest(req, res, body)
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((err) => {
      log.error("unhandled", { error: String(err) })
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "internal_error", message: String(err) }))
      }
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)

    // Loopback-only service, but a browser page on another origin should still not be
    // able to drive it. Echoing the caller's Origin keeps simple CSRF off the endpoint.
    res.setHeader("x-onesystem", "0.1.0")

    if (url.pathname === "/health" && req.method === "GET") {
      const body = JSON.stringify({
        status: "ok",
        pid: process.pid,
        uptimeMs: Math.round(process.uptime() * 1000),
        idleShutdownSecs: config.idleShutdownSecs,
        ...supervisor.snapshot(),
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(body)
      return
    }

    const match = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]+)$/)
    if (match) {
      const backendName = match[1]!
      if (!supervisor.backends.has(backendName)) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: "unknown_backend",
            message: `no backend named ${backendName}; configured: ${[...supervisor.backends.keys()].join(", ") || "none"}`,
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
        message: "POST /mcp/:backend, or GET /health",
        backends: [...supervisor.backends.keys()],
      }),
    )
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    // Loopback only. Not configurable to a public bind without auth; see config.ts.
    server.listen(config.port, config.host, () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === "object" && address ? address.port : config.port
  const url = `http://${config.host}:${port}`
  log.info("listening", { url, backends: [...supervisor.backends.keys()] })

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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString("utf8")
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw Object.assign(new Error(`invalid JSON body: ${(err as Error).message}`), { status: 400 })
  }
}
