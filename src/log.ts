/**
 * Structured logging to stderr, with a stable prefix.
 *
 * stderr, never stdout. The daemon's stdout is not a JSON-RPC channel the way the
 * old shim's was, but keeping logs off stdout means a future stdio mode would not
 * corrupt the protocol stream, and `onesystem status` can safely capture stdout.
 *
 * ## The sink is injectable
 *
 * The only way to assert anything about log output used to be to monkey-patch
 * `process.stderr.write`, which is why there were no tests for this module at all. The
 * sink is a parameter now, so a test captures lines without touching global state, and
 * the plugin — which formats its own lines by hand to the same convention — can share the
 * format instead of keeping a second copy of it.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type Level = keyof typeof LEVELS

/** Where a formatted line goes. Defaults to the process's stderr. */
export type LogSink = (line: string) => void

const stderrSink: LogSink = (line) => void process.stderr.write(line)

function threshold(): number {
  const raw = (process.env.ONESYSTEM_LOG_LEVEL ?? "info").toLowerCase()
  return LEVELS[raw as Level] ?? LEVELS.info
}

/**
 * One line, in the format both the daemon and the plugin use.
 *
 * Shared so a log line can be recognised by whoever is reading it. The plugin used to
 * build `[onesystem:plugin] ...` by hand from the same convention, which is a second
 * implementation of a format that is meant to be greppable.
 */
export function formatLine(scope: string, level: Level, msg: string, extra?: Record<string, unknown>): string {
  const tail = extra && Object.keys(extra).length > 0 ? " " + JSON.stringify(extra) : ""
  return `[onesystem:${scope}] ${level} ${msg}${tail}\n`
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  /**
   * A logger for a sub-scope, e.g. `child("request")` gives `onesystem:http:request`.
   *
   * Kept because the format supports it and the plugin's per-target lines want it, but
   * note this was previously declared and never called by anything in the daemon.
   */
  child(scope: string): Logger
}

export function logger(scope: string, sink: LogSink = stderrSink): Logger {
  const emit = (level: Level) => (msg: string, extra?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold()) return
    sink(formatLine(scope, level, msg, extra))
  }
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (sub) => logger(`${scope}:${sub}`, sink),
  }
}

/** A logger that keeps lines in memory, for tests. */
export function capturingLogger(scope: string): { log: Logger; lines: string[] } {
  const lines: string[] = []
  return { log: logger(scope, (line) => void lines.push(line)), lines }
}
