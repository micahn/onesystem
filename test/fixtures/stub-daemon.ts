/**
 * Serve /health, /catalog, and /call over real HTTP to test address discovery and
 * tool registration. Record call bodies so tests can check forwarding too.
 */

import { createServer, type Server } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface StubDaemon {
  base: string
  /** Every `/call` body, in order. */
  calls: { backend: string; tool: string; arguments: unknown }[]
  /** Set to false to simulate a daemon that is not answering /health. */
  healthy: boolean
  close(): Promise<void>
  /**
   * A fake CLI that reports this daemon's address from `onesystem status`.
   *
   * `marker` is a file the fake appends the subcommand to, so a test can see that
   * `onesystem start` was run. Passed in rather than patched in afterwards: rewriting a
   * generated file from the test is how the previous version of this fixture ended up
   * calling an undefined `appendFileSync`.
   */
  cli(marker?: string): Promise<{ command: string; args: string[] }>
}

const TOOLS = {
  laya: {
    toolPrefix: "laya_",
    tools: {
      tools: [
        {
          name: "laya_predict",
          description: "Answer typed questions.",
          inputSchema: { type: "object", properties: { state: { type: "object" }, questions: { type: "object" } }, required: ["state", "questions"] },
        },
        {
          name: "laya_status",
          description: "Report the device in use.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  },
  julia: {
    tools: {
      tools: [
        {
          name: "predict",
          description: "Answer typed questions about a state.",
          inputSchema: { type: "object", properties: { state: { type: "string" }, questions: { type: "object" } }, required: ["state", "questions"] },
        },
      ],
    },
  },
}

export async function startStubDaemon(backends: Record<string, unknown> = { laya: TOOLS.laya }): Promise<StubDaemon> {
  const calls: StubDaemon["calls"] = []
  const state = { healthy: true }

  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    let raw = ""
    req.on("data", (d) => (raw += String(d)))
    req.on("end", () => {
      if (req.url === "/health") {
        if (!state.healthy) return send(503, { error: "unhealthy" })
        return send(200, {
          status: "ok",
          pid: process.pid,
          uptimeMs: 1000,
          idleShutdownSecs: 600,
          anyLocalWarm: true,
          backends: Object.keys(backends).map((name) => ({
            name,
            transport: "stdio-mcp",
            state: "warm",
            inflight: 0,
            idleMs: 0,
            local: true,
          })),
        })
      }
      if (req.url === "/catalog") return send(200, { backends: Object.entries(backends).map(([backend, b]) => ({ backend, ...(b as object) })) })
      if (req.url === "/call") {
        const body = JSON.parse(raw || "{}")
        calls.push(body)
        return send(200, { result: { content: [{ type: "text", text: JSON.stringify({ echoed: body.arguments }) }] } })
      }
      send(404, { error: "not_found" })
    })
  })

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`

  const dirs: string[] = []
  const stub: StubDaemon = {
    base,
    calls,
    get healthy() {
      return state.healthy
    },
    set healthy(v: boolean) {
      state.healthy = v
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
    async cli(marker?: string) {
      const dir = await mkdtemp(join(tmpdir(), "onesystem-stub-"))
      dirs.push(dir)
      const script = join(dir, "cli.ts")
      const names = Object.keys(backends)
      await writeFile(
        script,
        `import { appendFileSync } from "node:fs"\n` +
          `const sub = process.argv[2]\n` +
          `if (sub === "status") {\n` +
          `  process.stdout.write(JSON.stringify({\n` +
          `    url: ${JSON.stringify(base)},\n` +
          `    registrations: ${JSON.stringify(names.map((n) => ({ backend: n, serverName: `onesystem-${n}` })))},\n` +
          `  }))\n` +
          `  process.exit(0)\n` +
          `}\n` +
          `appendFileSync(${JSON.stringify(marker ?? join(dir, "unused.log"))}, sub + "\\n")\n`,
      )
      return { command: process.execPath, args: [script] }
    },
  }
  const closeAll = stub.close
  stub.close = async () => {
    await closeAll()
    for (const d of dirs) await rm(d, { recursive: true, force: true })
  }
  return stub
}

export { TOOLS as STUB_TOOLS }
