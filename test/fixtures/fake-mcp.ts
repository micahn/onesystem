/**
 * A real MCP server over stdio, used by the lazy-start test.
 *
 * Deliberately built on the SDK rather than mocked, because the property under test is
 * about process and protocol behaviour: that spawning this does no work until a
 * request arrives. A mock would not have a stdout handshake to wait on, and the whole
 * failure mode being guarded against is a real one.
 *
 * Writes a line to $FAKE_MCP_MARKER on startup, before it binds stdio, which is what
 * the test watches for. That ordering mirrors the real laya shim, and is the reason a
 * cold connect is silent for as long as it is.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync } from "node:fs"

const marker = process.env.FAKE_MCP_MARKER
if (marker) appendFileSync(marker, "spawned\n")

const server = new Server({ name: "fake-system1", version: "0.0.1" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "decide", description: "test tool", inputSchema: { type: "object" } }],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (marker) appendFileSync(marker, "called\n")
  return { content: [{ type: "text", text: `ok:${req.params.name}` }] }
})

await server.connect(new StdioServerTransport())
