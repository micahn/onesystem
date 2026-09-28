/**
 * Deadlines must stop real child processes before callers remove staging files.
 * A mocked kill call cannot prove the process exited.
 */

import { describe, expect, test } from "bun:test"
import { DEFAULT_TIMEOUT_MS, run, SPAWN_FAILED_CODE, TIMEOUT_CODE } from "../src/subprocess.ts"

describe("running a command", () => {
  test("it reports the exit code and both streams", async () => {
    const res = await run("sh", ["-c", "echo out; echo err 1>&2; exit 3"])
    expect(res.code).toBe(3)
    expect(res.stdout.trim()).toBe("out")
    expect(res.stderr.trim()).toBe("err")
    expect(res.timedOut).toBe(false)
  })

  test("a binary that does not exist is 127, not a rejection", async () => {
    // The contract callers rely on: `run` never rejects, so a missing tool is a value to
    // branch on rather than a try/catch. 127 is what a shell reports for "command not
    // found", so the number is not a surprise to whoever reads the message.
    const res = await run("definitely-not-a-real-binary-xyzzy", [])
    expect(res.code).toBe(SPAWN_FAILED_CODE)
    expect(res.timedOut).toBe(false)
    expect(res.stderr).toMatch(/not found|ENOENT/i)
  })

  test("it runs in the directory it was given", async () => {
    const res = await run("sh", ["-c", "pwd"], { cwd: "/tmp" })
    // macOS resolves /tmp through a symlink; compare the tail.
    expect(res.stdout.trim().endsWith("tmp")).toBe(true)
  })

  test("the environment is added to, not replaced", async () => {
    // A subprocess that cannot see PATH cannot find anything, and `install` passes
    // `env` for the shim's variables rather than for a hermetic build.
    const res = await run("sh", ["-c", "echo $PATH; echo $ONESYSTEM_TEST_VAR"], {
      env: { ONESYSTEM_TEST_VAR: "present" },
    })
    const [path, value] = res.stdout.trim().split("\n")
    expect(value).toBe("present")
    expect(path!.length).toBeGreaterThan(1)
  })
})

describe("a deadline stops the work, rather than only reporting on it", () => {
  test("a process that outlives its deadline is killed and reported as a timeout", async () => {
    // `sleep 30` would hold this test for 30 seconds if the deadline did not work, which
    // is the point: the assertion is that the call returns in about the timeout, and that
    // the child is gone rather than orphaned.
    const started = Date.now()
    const res = await run("sh", ["-c", "sleep 30"], { timeoutMs: 250 })
    const elapsed = Date.now() - started

    expect(res.timedOut).toBe(true)
    // 124 rather than whatever the signal left behind, so a caller can tell a timeout from
    // a crash without pattern-matching an exit code that a shell also uses.
    expect(res.code).toBe(TIMEOUT_CODE)
    expect(elapsed).toBeLessThan(5_000)
  })

  test("a child that ignores SIGTERM is still gone", async () => {
    // The reason the seam escalates to SIGKILL. Without it, `trap "" TERM` would hold the
    // deadline open indefinitely, which is the exact failure the deadline was added to
    // prevent -- and a Python process ignoring SIGTERM is not hypothetical.
    //
    // This is the one test that waits out the kill grace period, so it needs a budget
    // longer than bun's 5s default -- and that is the only reason it is slow. The grace
    // period is a production value (a child gets a chance to clean up before SIGKILL) and
    // is not shortened to make a test quick. It is kept because the escalation is the part
    // that would otherwise be taken on trust.
    const res = await run("sh", ["-c", "trap '' TERM; sleep 30"], { timeoutMs: 200 })
    expect(res.timedOut).toBe(true)
    expect(res.code).toBe(TIMEOUT_CODE)
  }, 20_000)

  test("a caller can cancel without waiting for the deadline", async () => {
    const controller = new AbortController()
    const promise = run("sleep", ["30"], { timeoutMs: 60_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const res = await promise
    expect(res.timedOut).toBe(true)
  })

  test("a signal already aborted at call time does not leave the process running", async () => {
    // An aborted signal never fires its listener, so this has to be checked rather than
    // assumed. Killing a process the caller has already given up on is correct; leaving it
    // to run until the deadline is not.
    const res = await run("sh", ["-c", "sleep 30"], {
      timeoutMs: 60_000,
      signal: AbortSignal.abort(),
    })
    expect(res.timedOut).toBe(true)
  })

  test("a command that finishes in time is not reported as a timeout", async () => {
    const res = await run("sh", ["-c", "exit 0"], { timeoutMs: 30_000 })
    expect(res.timedOut).toBe(false)
    expect(res.code).toBe(0)
  })

  test("the default deadline is long enough for the work it is given", async () => {
    // Not a test of the number so much as of its intent: `onesystem install` downloads
    // several gigabytes, and a default shorter than a real install would fail a working
    // machine. This is the assertion that would catch someone "tidying" it down to 30s.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000)
  })
})

describe("output is bounded", () => {
  test("a stream that outgrows the cap keeps its tail and drops the rest", async () => {
    // `uv` on a bad network can emit more log than is worth holding, and the failure worth
    // reading is at the end. 200 KB in, 64 KB out, and the last byte survives.
    const res = await run("sh", ["-c", "head -c 200000 /dev/zero | tr '\\0' 'x'"], { timeoutMs: 30_000 })
    expect(res.stdout.length).toBeLessThanOrEqual(64 * 1024)
    expect(res.stdout.length).toBeGreaterThan(60 * 1024)
    expect(res.stdout.endsWith("x")).toBe(true)
  })

  test("output under the cap is untouched", async () => {
    const res = await run("sh", ["-c", "printf 'hello'"], { timeoutMs: 30_000 })
    expect(res.stdout).toBe("hello")
  })
})
