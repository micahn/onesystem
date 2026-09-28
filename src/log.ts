/**
 * Shared structured logging. Use stderr to keep status JSON on stdout readable.
 * Tests can inject a sink without changing global state.
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
 * Format one line for both the daemon and plugin.
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
   * Add a sub-scope: child("request") on "http" gives "onesystem:http:request".
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
