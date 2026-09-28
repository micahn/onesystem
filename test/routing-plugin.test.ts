/**
 * Routing, through the plugin.
 *
 * The unit tests in `routing.test.ts` cover the decision. This covers the consequence,
 * which is the thing that actually reaches the user: what opencode ends up being asked to
 * register, and therefore what an unqualified `onesystem.predict` resolves to.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/plugin/index.ts"

const cleanups: (() => Promise<void>)[] = []
const dirs: string[] = []

async function setup(options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "onesystem-route-"))
  dirs.push(dir)
  const script = join(dir, "cli.ts")
  const status = JSON.stringify({
    url: "http://127.0.0.1:7331",
    registrations: [
      { backend: "laya", serverName: "onesystem-laya" },
      { backend: "julia", serverName: "onesystem-julia" },
    ],
    ...(options.status ? { routing: options.status } : {}),
  })
  await writeFile(
    script,
    `const sub = process.argv[2]\n` +
      `if (sub === "status") { process.stdout.write(${JSON.stringify(status)}); process.exit(0) }\n` +
      `process.exit(0)\n`,
  )

  const registered: { name: string; url: string }[] = []
  const ctx = {
    options: { command: process.execPath, args: [script], noStart: true },
    mcp: {
      transform: async (cb: (e: { set(n: string, c: { url?: string }): void }) => void) => {
        cb({ set: (name, config) => registered.push({ name, url: config.url ?? "" }) })
        return { dispose: async () => {} }
      },
      reload: async () => {},
    },
    tool: { hook: async () => ({ dispose: async () => {} }) },
  }
  const cleanup = await plugin.setup(ctx as never)
  cleanups.push(async () => void (await cleanup?.()))
  return registered
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!().catch(() => {})
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

describe("routing reaches the registration", () => {
  test("off by default: every backend keeps its own qualified name", async () => {
    // The default. An unqualified call is the agent's to make, and the tool surface names
    // both models so it can.
    const names = (await setup()).map((r) => r.name).sort()
    expect(names).toEqual(["onesystem-julia", "onesystem-laya"])
  })

  test("on: the chosen default takes the bare name, so an unqualified call reaches it", async () => {
    const names = (await setup({ status: { enabled: true, default: "julia" } })).map((r) => r.name)
    expect(names).toContain("onesystem")
    expect(names).toContain("onesystem-laya")
    // And julia's URL is the one behind the bare name.
    const bare = (await setup({ status: { enabled: true, default: "julia" } })).find((r) => r.name === "onesystem")!
    expect(bare.url).toBe("http://127.0.0.1:7331/mcp/julia")
  })

  test("on: the default can be either model", async () => {
    const bare = (await setup({ status: { enabled: true, default: "laya" } })).find((r) => r.name === "onesystem")!
    expect(bare.url).toBe("http://127.0.0.1:7331/mcp/laya")
  })

  test("a task map does not change what is registered", async () => {
    // Guidance, not dispatch. Routing a call by matching its text for a task name would be
    // a classifier in front of a classifier, and wrong in a way nobody could debug.
    const withMap = (await setup({ status: { enabled: true, default: "julia", tasks: { engineering: "laya" } } })).map((r) => r.name)
    const without = (await setup({ status: { enabled: true, default: "julia" } })).map((r) => r.name)
    expect(withMap.sort()).toEqual(without.sort())
  })
})
