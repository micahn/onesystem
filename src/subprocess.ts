/**
 * Run subprocesses with cancellation, a deadline, and capped output tails.
 * Cancellation sends SIGTERM, then SIGKILL after a grace period, and reports
 * code 124 with timedOut set. The child must stop before staging files are removed.
 */

import { spawn } from "node:child_process"
import { startDeadline } from "./async.ts"

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  /**
   * Kill after this many milliseconds. The default allows large runtime downloads.
   */
  timeoutMs?: number
  /** The caller's own cancellation, honoured in addition to the deadline. */
  signal?: AbortSignal
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** True when the deadline killed it. `code` is then `TIMEOUT_CODE`. */
  timedOut: boolean
}

/**
 * Injectable command runner for install, GPU detection, and verification.
 */
export type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>

/** Conventional exit code for "killed by a deadline", so a caller need not use the flag. */
export const TIMEOUT_CODE = 124
/** The binary could not be spawned at all: absent, or not executable. */
export const SPAWN_FAILED_CODE = 127

/** Ten minutes. See `RunOptions.timeoutMs` for why this is not shorter. */
export const DEFAULT_TIMEOUT_MS = 600_000

/** How long a child gets to exit after SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 5_000

/** Per-stream cap on what is kept. The tail is the part worth reading. */
const MAX_OUTPUT = 64 * 1024

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise<RunResult>((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Trim after appending so a single large chunk cannot exceed the retained limit.
    const keep = (s: string, chunk: string) => {
      const next = s + chunk
      return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next
    }
    child.stdout?.on("data", (d) => (stdout = keep(stdout, String(d))))
    child.stderr?.on("data", (d) => (stderr = keep(stderr, String(d))))

    const deadline = startDeadline(timeoutMs)

    const kill = () => {
      timedOut = true
      child.kill("SIGTERM")
      const hard = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
      hard.unref?.()
    }
    const onAbort = () => kill()
    deadline.signal.addEventListener("abort", kill, { once: true })
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      deadline.dispose()
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }

    // An already-aborted signal will not fire the new listener.
    if (opts.signal?.aborted) kill()

    // A spawn error means the process never ran; use the shell's conventional code 127.
    child.on("error", (err) =>
      finish({ code: SPAWN_FAILED_CODE, stdout, stderr: stderr + String(err), timedOut }),
    )
    child.on("close", (code) =>
      finish({ code: timedOut ? TIMEOUT_CODE : (code ?? 1), stdout, stderr, timedOut }),
    )
  })
}
