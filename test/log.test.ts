/**
 * Log formatting, and the deadline helpers.
 *
 * Both were previously untestable rather than unimportant: the logger wrote straight to
 * `process.stderr.write` with no way in, and `describeError` existed as two private copies
 * in two modules with two different output formats for the same error.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { capturingLogger, formatLine, logger } from "../src/log.ts"
import { describeError, startDeadline, withTimeout } from "../src/async.ts"
import { VERSION } from "../src/version.ts"

const previousLevel = process.env.ONESYSTEM_LOG_LEVEL

afterEach(() => {
  if (previousLevel === undefined) delete process.env.ONESYSTEM_LOG_LEVEL
  else process.env.ONESYSTEM_LOG_LEVEL = previousLevel
})

describe("log lines", () => {
  test("a line is greppable by scope and level", () => {
    expect(formatLine("http", "info", "listening", { port: 7331 })).toBe(
      '[onesystem:http] info listening {"port":7331}\n',
    )
  })

  test("extra is omitted entirely when empty, not printed as {}", () => {
    expect(formatLine("x", "warn", "careful")).toBe("[onesystem:x] warn careful\n")
    expect(formatLine("x", "warn", "careful", {})).toBe("[onesystem:x] warn careful\n")
  })

  test("the level threshold is honoured", () => {
    process.env.ONESYSTEM_LOG_LEVEL = "warn"
    const { log, lines } = capturingLogger("test")
    log.debug("hidden")
    log.info("hidden")
    log.warn("shown")
    log.error("shown")
    expect(lines).toEqual(['[onesystem:test] warn shown\n', '[onesystem:test] error shown\n'])
  })

  test("an unknown level name falls back to info rather than silencing everything", () => {
    process.env.ONESYSTEM_LOG_LEVEL = "chatty"
    const { log, lines } = capturingLogger("test")
    log.info("kept")
    log.debug("dropped")
    expect(lines).toHaveLength(1)
  })

  test("a child scope nests rather than replacing", () => {
    const { log, lines } = capturingLogger("http")
    log.child("session").info("opened")
    expect(lines).toEqual(['[onesystem:http:session] info opened\n'])
  })

  test("the sink is a parameter, so this module is testable at all", () => {
    // The reason there were no tests here before: the only way in was
    // monkey-patching process.stderr.write.
    const seen: string[] = []
    logger("t", (line) => void seen.push(line)).info("captured")
    expect(seen).toEqual(['[onesystem:t] info captured\n'])
  })
})

describe("describeError", () => {
  test("an ordinary Error reads as its message, not 'Error: ...'", () => {
    expect(describeError(new Error("connect ECONNREFUSED"))).toBe("connect ECONNREFUSED")
  })

  test("a named subclass keeps its name, because that is what identifies it", () => {
    class McpError extends Error {
      override name = "McpError"
    }
    expect(describeError(new McpError("bad schema"))).toBe("McpError: bad schema")
  })

  test("a non-Error is stringified", () => {
    expect(describeError("just a string")).toBe("just a string")
    expect(describeError(42)).toBe("42")
    expect(describeError(null)).toBe("null")
  })
})

describe("startDeadline", () => {
  test("the signal fires when the deadline passes, and says it was the deadline", async () => {
    const deadline = startDeadline(20)
    expect(deadline.signal.aborted).toBe(false)
    expect(deadline.timedOut()).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.timedOut()).toBe(true)
    deadline.dispose()
  })

  test("disposing clears the timer so it cannot hold the event loop open", async () => {
    const deadline = startDeadline(50)
    deadline.dispose()
    await new Promise((r) => setTimeout(r, 120))
    expect(deadline.signal.aborted).toBe(false)
  })
})

describe("withTimeout", () => {
  test("passes a value through", async () => {
    expect(await withTimeout(Promise.resolve("ok"), 1000, "thing")).toBe("ok")
  })

  test("rejects with the budget named when the promise overruns", async () => {
    await expect(withTimeout(new Promise(() => {}), 20, "slow thing")).rejects.toThrow(/slow thing exceeded 20ms/)
  })

  test("propagates a rejection rather than reporting a timeout", async () => {
    await expect(withTimeout(Promise.reject(new Error("inner")), 1000, "thing")).rejects.toThrow("inner")
  })
})

describe("version", () => {
  test("the reported version matches package.json", async () => {
    // Four places used to spell this out: package.json, the MCP server info in two
    // adapters, and the x-onesystem header. Three of them can now drift silently.
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})
