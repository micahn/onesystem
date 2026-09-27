/**
 * An MCP server that takes its time before binding stdio.
 *
 * This models the real thing, which is why it exists. `laya-mcp-idle-server` imports
 * transformers and does that *before* it binds stdio, so a cold connect is silent for
 * 25-30s. Any shutdown that lands inside that window used to be lost: the adapter's
 * `stop()` read the client field, which is only assigned once `connect()` resolves, so it
 * closed nothing, returned, and let the daemon release its lock. The handshake then
 * completed, set the state to `warm`, and left a live process holding VRAM that a
 * successor daemon had no way to see.
 *
 * `$FAKE_MCP_HANDSHAKE_MS` is how long to stall before binding. The test quiesces during
 * the stall and asserts nothing is left warm afterwards.
 *
 * `$FAKE_MCP_LINGER_MS` keeps the process alive after the parent goes away, so a test can
 * see whether the child was actually reaped. Without it the process would exit on stdin
 * closing regardless, and the test could not tell a real teardown from an incidental exit.
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
