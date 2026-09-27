/**
 * Structured logging to stderr, with a stable prefix.
 *
 * stderr, never stdout. The daemon's stdout is not a JSON-RPC channel the way the
 * old shim's was, but keeping logs off stdout means a future stdio mode would not
 * corrupt the protocol stream, and `onesystem status` can safely capture stdout.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type Level = keyof typeof LEVELS

function threshold(): number {
  const raw = (process.env.ONESYSTEM_LOG_LEVEL ?? "info").toLowerCase()
  return LEVELS[raw as Level] ?? LEVELS.info
}

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>) {
  if (LEVELS[level] < threshold()) return
  const tail = extra && Object.keys(extra).length > 0 ? " " + JSON.stringify(extra) : ""
  process.stderr.write(`[onesystem:${scope}] ${level} ${msg}${tail}\n`)
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  child(scope: string): Logger
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
    child: (sub) => logger(`${scope}:${sub}`),
  }
}
