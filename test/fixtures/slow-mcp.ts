/**
 * Delay binding by FAKE_MCP_HANDSHAKE_MS to test shutdown during startup.
 * FAKE_MCP_LINGER_MS keeps the child alive after stdin closes, so tests can prove
 * that cleanup killed it rather than relying on an incidental exit.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync } from "node:fs"

const marker = process.env.FAKE_MCP_MARKER
const handshakeMs = Number(process.env.FAKE_MCP_HANDSHAKE_MS ?? 0)
const lingerMs = Number(process.env.FAKE_MCP_LINGER_MS ?? 0)

if (marker) appendFileSync(marker, "spawned\n")

if (handshakeMs > 0) {
  await new Promise((r) => setTimeout(r, handshakeMs))
  if (marker) appendFileSync(marker, "handshake-done\n")
}

const server = new Server({ name: "slow-system1", version: "0.0.1" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "decide", description: "test tool", inputSchema: { type: "object" } }],
}))

await server.connect(new StdioServerTransport())
if (marker) appendFileSync(marker, "connected\n")

if (lingerMs > 0) {
  // Stay alive regardless of stdin. A teardown that closes the transport will kill us;
  // one that does not will still be here when the test looks.
  setTimeout(() => {
    if (marker) appendFileSync(marker, "lingering\n")
    process.exit(0)
  }, lingerMs).unref()
  // Hold the event loop so the linger timer is the only thing that can end this process.
  await new Promise(() => {})
}
