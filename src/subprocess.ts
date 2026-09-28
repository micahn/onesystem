/**
 * The project's one subprocess seam.
 *
 * Three modules were spawning processes, in three shapes, with three answers to "what
 * happens if it hangs":
 *
 *   - `plugin/discover.ts#run` — resolves an exit code, reports stderr, no deadline.
 *   - `supervisor.ts` — layers `withTimeout` on top of a backend call as a backstop.
 *   - `install.ts#run` — spawns, accumulates stdout and stderr into unbounded strings,
 *     and has no deadline, no kill, and no cancellation at all.
 *
 * The installer's is the one that mattered. `onesystem install` downloads several GB and
 * spends minutes in `uv`, so a hung `uv lock` on a flaky network, a wedged `uv sync`, or a
 * `verify()` whose `import torch` stalls behind a busy GPU all left the command waiting
 * forever — no diagnostic, and no way out but killing the terminal. The daemon had already
 * solved the deadline problem and said so once, in `async.ts`; this is the subprocess half
 * of that answer, and it is deliberately the same discipline rather than a fourth shape.
 *
 * ## What "bounded" means here
 *
 * A deadline that rejects while the child keeps running is not a timeout, it is a guess:
 * the caller walks away believing the work stopped, and `uv` is still holding the staging
 * directory it was told to write into. So the deadline here *kills* — SIGTERM, then
 * SIGKILL after a grace period, because a child that ignores SIGTERM would otherwise hold
 * the deadline open indefinitely, which is the exact failure the deadline was added to
 * prevent. `code` then reports `124` and `timedOut` is set, so a caller can say which step
 * gave up without pattern-matching an exit code.
 *
 * Output is capped for the same reason the strings were unbounded: `uv` on a bad network
 * can emit more log than is worth keeping, and a failure worth reading is in the tail, so
 * the tail is what survives.
 */

import { spawn } from "node:child_process"
import { startDeadline } from "./async.ts"

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  /**
   * Kill and report a timeout after this long.
   *
   * Generous by default, because the honest caller here downloads gigabytes and a deadline
   * shorter than a real install would fail a working machine. It exists to stop a *hang*,
   * not to police a slow network.
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
 * The seam's shape.
 *
 * A `Runner` is what `install()` and `verify()` take instead of reaching for `spawn`, and
 * it is what a test scripts. Typed as an interface rather than as a class so a test's fake
 * is an object literal.
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

    // Append, then keep the tail. Checking before appending would let a single enormous
    // chunk through unbounded, which is the case that actually happens.
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

    // A signal that was already aborted at call time never fires its listener, so this has
    // to be checked rather than assumed. Killing a process the caller has already given up
    // on is correct; leaving it running until the deadline is not.
    if (opts.signal?.aborted) kill()

    // `error` is spawn failure, not a non-zero exit: the process never ran. 127 is what a
    // shell reports for "command not found", so the number is not a surprise to whoever
    // reads the message above it.
    child.on("error", (err) =>
      finish({ code: SPAWN_FAILED_CODE, stdout, stderr: stderr + String(err), timedOut }),
    )
    child.on("close", (code) =>
      finish({ code: timedOut ? TIMEOUT_CODE : (code ?? 1), stdout, stderr, timedOut }),
    )
  })
}
