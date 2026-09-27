/**
 * Config validation.
 *
 * The case that matters is refusal. A backend with a missing or malformed `command`
 * would otherwise start a daemon that listens, answers, and is talking to nothing, which
 * is far more expensive to debug than a boot that stops and names the field.
 */

import { describe, expect, test } from "bun:test"
import { DEFAULTS, validate } from "../src/config.ts"

describe("config validation", () => {
  test("accepts a minimal config and applies defaults", () => {
    const config = validate({}, "test")
    expect(config.port).toBe(DEFAULTS.port)
    expect(config.host).toBe("127.0.0.1")
    expect(config.idleShutdownSecs).toBe(DEFAULTS.idleShutdownSecs)
    expect(config.backends).toEqual({})
  })

  test("loopback is the default host", () => {
    expect(validate({}, "test").host).toBe("127.0.0.1")
  })

  test("accepts both transports", () => {
    const config = validate(
      {
        backends: {
          laya: { transport: "stdio-mcp", command: ["python", "-m", "laya.mcp.server"] },
          rev: { transport: "systemone-http", baseUrl: "http://127.0.0.1:8000/" },
        },
      },
      "test",
    )
    expect(config.backends.laya!.transport).toBe("stdio-mcp")
    expect(config.backends.rev!.transport).toBe("systemone-http")
    // Trailing slash normalised away so URL joining stays predictable.
    expect((config.backends.rev as { baseUrl: string }).baseUrl).toBe("http://127.0.0.1:8000")
  })

  test("enabled defaults to true and can be turned off", () => {
    const config = validate(
      {
        backends: {
          on: { transport: "stdio-mcp", command: ["x"] },
          off: { transport: "stdio-mcp", command: ["x"], enabled: false },
        },
      },
      "test",
    )
    expect(config.backends.on!.enabled).toBe(true)
    expect(config.backends.off!.enabled).toBe(false)
  })

  test("rejects an unknown transport", () => {
    expect(() => validate({ backends: { x: { transport: "grpc" } } }, "test")).toThrow(/transport must be/)
  })

  test("rejects a stdio backend with no command", () => {
    expect(() => validate({ backends: { x: { transport: "stdio-mcp" } } }, "test")).toThrow(/command/)
    expect(() => validate({ backends: { x: { transport: "stdio-mcp", command: [] } } }, "test")).toThrow(/command/)
  })

  test("rejects a stdio command that is not all strings", () => {
    expect(() => validate({ backends: { x: { transport: "stdio-mcp", command: ["py", 3] } } }, "test")).toThrow(
      /command/,
    )
  })

  test("rejects a systemone backend with a non-http baseUrl", () => {
    expect(() => validate({ backends: { x: { transport: "systemone-http", baseUrl: "localhost" } } }, "test")).toThrow(
      /baseUrl/,
    )
  })

  test("rejects non-positive numbers rather than silently defaulting", () => {
    expect(() => validate({ port: -1 }, "test")).toThrow(/port/)
    expect(() => validate({ port: 70000 }, "test")).toThrow(/port/)
    expect(() => validate({ port: 1.5 }, "test")).toThrow(/port/)
    expect(() => validate({ idleShutdownSecs: "soon" }, "test")).toThrow(/idleShutdownSecs/)
    expect(() => validate({ idleShutdownSecs: 0 }, "test")).toThrow(/idleShutdownSecs/)
  })

  test("accepts port 0, which asks the kernel for a free one", () => {
    // Zero is a real request, not a mistake: it is the only way to run a second daemon on
    // one machine without hand-picking a free port. Every test file used to invent its
    // own `7000 + random()` and hope.
    expect(validate({ port: 0 }, "test").port).toBe(0)
  })

  test("refuses a host that is not loopback", () => {
    // Asserted in four places and enforced in none. `validate` took any string and
    // `server.listen` bound it, so `"0.0.0.0"` published an unauthenticated MCP endpoint
    // to the network. The endpoint has no auth and accepts any size body.
    expect(() => validate({ host: "0.0.0.0" }, "test")).toThrow(/loopback/)
    expect(() => validate({ host: "192.168.1.10" }, "test")).toThrow(/loopback/)
    expect(validate({ host: "127.0.0.1" }, "test").host).toBe("127.0.0.1")
    expect(validate({ host: "::1" }, "test").host).toBe("::1")
    expect(validate({ host: "localhost" }, "test").host).toBe("localhost")
    expect(validate({ host: "127.0.0.2" }, "test").host).toBe("127.0.0.2")
  })

  test("refuses an idle sweep coarser than the window it guards", () => {
    // A sweep coarser than the window is mostly harmless on its own — shutdown is just
    // late. But a window shorter than the interval means the tick which first notices a
    // backend warm can also decide it went quiet, winding the daemon down under a request
    // that just completed. The shipped config is 600/5; this is the relationship stated.
    expect(() => validate({ idleShutdownSecs: 5, idleSweepSecs: 10 }, "test")).toThrow(/idleSweepSecs/)
    expect(validate({ idleShutdownSecs: 5, idleSweepSecs: 5 }, "test").idleSweepSecs).toBe(5)
  })

  test("names the offending field and the source in the message", () => {
    expect(() => validate({ backends: { laya: { transport: "stdio-mcp" } } }, "my-config.json")).toThrow(
      /my-config\.json.*backends\.laya\.command/s,
    )
  })
})
