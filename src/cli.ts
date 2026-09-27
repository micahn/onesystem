/**
 * `onesystem` CLI.
 *
 *   serve    run the daemon in the foreground (what `start` re-execs into)
 *   start    start a detached daemon, or report that one is already up
 *   stop     ask a running daemon to exit
 *   status   report what is running, loading nothing
 *
 * `start` is the interesting one. It must be safe to call from many opencode sessions
 * at once, which is the same race the plugin has. It resolves it in three steps rather
 * than one: probe health, and if nothing answers, spawn a detached `serve` and wait
 * for /health to answer. The spawned daemon takes the lock, so if several sessions race
 * here, every one of them ends up waiting on the same winner. Waiting on health rather
 * than on the child's exit is what makes this correct: the loser's `serve` exits with
 * code 3 and the loser treats that as success, because someone is serving.
 */

import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { configDir, configPathOrDefault, loadConfig, lockPath, registrations, stateDir, type Config } from "./config.ts"
import { inspect } from "./lock.ts"
import { runDaemon, probe } from "./daemon.ts"
import { logger } from "./log.ts"

const log = logger("cli")

function baseUrl(config: Config): string {
  return `http://${config.host}:${config.port}`
}

function parseArgs(argv: string[]): { command: string; rest: string[] } {
  const command = argv[0] ?? "status"
  return { command, rest: argv.slice(1) }
}

async function cmdServe(config: Config): Promise<void> {
  await runDaemon(config)
  // runDaemon resolves once the server is listening; hold the process open until a
  // signal or the idle sweep ends it.
  await new Promise(() => {})
}

async function cmdStart(config: Config): Promise<number> {
  const url = baseUrl(config)

  const existing = await probe(url)
  if (existing) {
    log.info("already running", { url, pid: existing.pid })
    return 0
  }

  // The daemon's stderr goes to a log file, not to our stderr.
  //
  // Inheriting it looks harmless and is not: the daemon outlives this process, so it
  // keeps the inherited descriptor open, and anything capturing our output --
  // `$(onesystem start)`, a pipe into `tail`, a CI log -- blocks until the daemon
  // exits, which may be hours. A detached process's diagnostics belong in a file.
  const logPath = join(stateDir(), "daemon.log")
  await mkdir(stateDir(), { recursive: true })
  const logFd = openSync(logPath, "a")

  const child = spawn(process.execPath, [import.meta.filename ?? "src/cli.ts", "serve"], {
    detached: true,
    stdio: ["ignore", "ignore", logFd],
    env: process.env,
  })
  child.unref()
  closeSync(logFd)
  log.info("spawned daemon", { pid: child.pid, url, log: logPath })

  // Wait for health. The cold daemon binds its port before any model loads, so this
  // returns in well under a second and is not the 20-54s model cost.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await Bun.sleep(100)
    const health = await probe(url)
    if (health) {
      log.info("daemon healthy", { url, pid: health.pid })
      return 0
    }
    if (child.exitCode !== null) {
      // Exit 3 is LockBusy: we lost the race to a sibling, and that sibling is now
      // serving. Wait for its health rather than reporting failure.
      if (child.exitCode === 3) continue
      log.error("daemon exited during startup", { code: child.exitCode })
      return child.exitCode ?? 1
    }
  }

  log.error("daemon did not become healthy in time", { url })
  return 1
}

async function cmdStop(config: Config): Promise<number> {
  const url = baseUrl(config)
  const health = await probe(url)
  if (!health) {
    log.info("no daemon reachable", { url })
    return 0
  }
  const pid = typeof health.pid === "number" ? health.pid : null
  if (pid === null) {
    log.error("daemon did not report a pid")
    return 1
  }
  try {
    process.kill(pid, "SIGTERM")
    log.info("sent SIGTERM", { pid })
  } catch (err) {
    log.error("kill failed", { pid, error: String(err) })
    return 1
  }

  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100)
    if (!(await probe(url))) {
      log.info("daemon exited")
      return 0
    }
  }
  log.error("daemon did not exit within 10s", { pid })
  return 1
}

async function cmdStatus(config: Config, configPath: string): Promise<number> {
  const url = baseUrl(config)
  const health = await probe(url)
  const holder = await inspect(lockPath()).catch(() => null)

  const report = {
    config: configPath,
    configDir: configDir(),
    url,
    running: health !== null,
    daemon: health,
    lock: holder,
    // The names the plugin will actually register, not a restatement of the config, so
    // `status` and the live tool surface cannot drift apart.
    registrations: registrations(config),
    idleShutdownSecs: config.idleShutdownSecs,
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  return 0
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command } = parseArgs(argv)

  if (command === "config-path") {
    process.stdout.write(configPathOrDefault() + "\n")
    return 0
  }

  let loaded: { config: Config; path: string }
  try {
    loaded = await loadConfig()
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 2
  }
  const { config, path } = loaded

  switch (command) {
    case "serve":
      await cmdServe(config)
      return 0
    case "start":
      return cmdStart(config)
    case "stop":
      return cmdStop(config)
    case "status":
      return cmdStatus(config, path)
    default:
      process.stderr.write(
        `unknown command: ${command}\nusage: onesystem <serve|start|stop|status|config-path>\n`,
      )
      return 2
  }
}

if (import.meta.main) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code)
    },
    (err) => {
      process.stderr.write(`onesystem: ${String(err)}\n`)
      process.exit(1)
    },
  )
}
