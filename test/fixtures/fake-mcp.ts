/**
 * Real SDK-based stdio server for lazy-start and protocol tests.
 * Write FAKE_MCP_MARKER before binding stdio so tests can detect process startup.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync } from "node:fs"

const marker = process.env.FAKE_MCP_MARKER
if (marker) appendFileSync(marker, "spawned\n")

// Configurable so a test can model a backend that prefixes its tools with its own
// product name, which is the case the bridge's `toolPrefix` exists to undo.
const toolName = process.env.FAKE_MCP_TOOL ?? "decide"

// How long a `tools/call` takes. Zero by default, so the lazy-start test is unaffected; a
// test that needs to abort mid-call sets it long and watches the marker to know the call
// actually reached the handler. Without a slow call there is no window in which a call is
// genuinely in flight, and an abort test can only assert that a rejection happened.
const callMs = Number(process.env.FAKE_MCP_CALL_MS ?? 0)

const server = new Server({ name: "fake-system1", version: "0.0.1" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: toolName, description: "test tool", inputSchema: { type: "object" } }],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (marker) appendFileSync(marker, "called\n")
  if (callMs > 0) {
    // The marker above is what a test waits for: it is written on entry, so a test can
    // abort knowing the handler is running rather than guessing from a sleep.
    await new Promise((r) => setTimeout(r, callMs))
  }
  if (marker) appendFileSync(marker, "call-done\n")
  return { content: [{ type: "text", text: `ok:${req.params.name}` }] }
})

await server.connect(new StdioServerTransport())
