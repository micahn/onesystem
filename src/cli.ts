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
 *
 * ## `status` is the daemon's machine interface
 *
 * The opencode plugin does not import any of this. It runs `status` and reads the JSON,
 * which makes this payload the seam between the two. That is why `DaemonStatus` lives in
 * `config.ts` next to the naming rules and the address it reports: the plugin used to
 * re-derive both, in an anonymous type, from a hardcoded port and an environment variable
 * no daemon code reads. Now there is one answer to "what should I register, and where",
 * produced by the same code that decides the answer.
 */

import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { loadConfig, type Config } from "./config.ts"
import { configCandidates, configDir, daemonUrl, lockPath, stateDir } from "./paths.ts"
import { registrations } from "./naming.ts"
import type { DaemonStatus } from "./health.ts"
import { inspect } from "./lock.ts"
import { runDaemon, probe, LOCK_BUSY_EXIT } from "./daemon.ts"
import { describeError } from "./async.ts"
import { switchToBackend, writeBackend } from "./config-edit.ts"
import { findModel, MODELS } from "./models.ts"
import {
  backendFor,
  configHint,
  detectGpu,
  install,
  listRuntimes,
  needsManualCommand,
  runtimeDir,
  runtimesRoot,
  uninstall,
  verify,
} from "./install.ts"
import { logger } from "./log.ts"
import { run } from "./subprocess.ts"

const log = logger("cli")

const USAGE = `usage: onesystem <serve|start|stop|status|config-path|install|uninstall|use|runtimes|doctor>`

function parseArgs(argv: string[]): { command: string } {
  return { command: argv[0] ?? "status" }
}


async function cmdServe(config: Config): Promise<void> {
  await runDaemon(config)
  // runDaemon resolves once the server is listening; hold the process open until a
  // signal or the idle sweep ends it.
  await new Promise(() => {})
}

async function cmdStart(config: Config): Promise<number> {
  const url = daemonUrl(config.host, config.port)

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
      // LOCK_BUSY is exit 3: we lost the race to a sibling, and that sibling is now
      // serving. Wait for its health rather than reporting failure.
      if (child.exitCode === LOCK_BUSY_EXIT) continue
      log.error("daemon exited during startup", { code: child.exitCode })
      return child.exitCode ?? 1
    }
  }

  log.error("daemon did not become healthy in time", { url })
  return 1
}

async function cmdStop(config: Config): Promise<number> {
  const url = daemonUrl(config.host, config.port)
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
  const url = daemonUrl(config.host, config.port)
  const health = await probe(url)
  const holder = await inspect(lockPath()).catch(() => null)

  const report: DaemonStatus = {
    config: configPath,
    configCandidates: configCandidates(),
    configDir: configDir(),
    // The address the daemon will actually answer on, from the config it actually
    // loaded. The plugin registers against this instead of rebuilding a URL from a
    // default port it has to keep in step with this file.
    url,
    running: health !== null,
    daemon: health,
    lock: holder,
    // The names the plugin will actually register, not a restatement of the config, so
    // `status` and the live tool surface cannot drift apart.
    registrations: registrations(config.backends),
    idleShutdownSecs: config.idleShutdownSecs,
    ...(config.routing ? { routing: config.routing } : {}),
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  return 0
}

async function cmdConfigPath(): Promise<number> {
  // The truth about which file is in use, and where the others would be. This used to
  // print one path from a helper whose own comment claimed it was "the config file that
  // would be used" — which is wrong for exactly the people who run it, since with no
  // user config the daemon falls back to the bundled example.
  const candidates = configCandidates()
  const inUse = candidates.find((p) => existsSync(p))
  if (inUse) {
    process.stdout.write(inUse + "\n")
  } else {
    process.stdout.write(`${candidates[0]}\n(no config exists; onesystem would use ${candidates[1]})\n`)
  }
  return 0
}

/**
 * Install a model into a Python environment onesystem owns.
 *
 * Not wired into the plugin's own setup. Installing 6 GB of torch is not something a
 * session should trigger as a side effect of opening a terminal, and a failed install
 * that leaves a half-configured backend is worse than no backend. The plugin will *use*
 * an installed model; a person installs one.
 */
async function cmdInstall(args: string[]): Promise<number> {
  const [name, ...rest] = args
  if (!name) {
    process.stderr.write(`usage: onesystem install <model>\nmodels: ${MODELS.map((m) => m.name).join(", ")}\n`)
    return 2
  }
  const spec = findModel(name)
  const lockOnly = rest.includes("--lock-only")
  try {
    const runtime = await install(spec, { runner: run, lockOnly, onProgress: (m) => log.info(m) })
    if (lockOnly) {
      log.info("resolved only; nothing downloaded", { model: name })
      return 0
    }
    const gpu = await detectGpu(run)
    const check = await verify(runtime.dir, gpu, run)
    process.stdout.write(`installed ${name}\n  interpreter: ${runtime.python}\n`)

    const backend = await backendFor(spec, runtime)
    // Not gated on `interpreterEnv`. That was the condition, and only laya has one, so
    // `onesystem install julia` said nothing about how to use what it had just built --
    // which is the only question someone has at that point.
    if (rest.includes("--no-config")) {
      process.stdout.write(`\nnot written to any config (--no-config). The block is:\n${configHint(spec, runtime, backend)}\n`)
    } else {
      // Installed *and* configured. The copy was the last manual step in the flow, and it
      // was the one that could fail invisibly: a block missing a key still parses, the
      // daemon still starts, and the mistake surfaces as an error payload on the first
      // tool call rather than as a config error.
      try {
        const { config, path } = await loadConfig()
        await writeBackend(path, name, backend, { enabled: true })
        const switched = await switchToBackend(path, config, name)
        process.stdout.write(`\nconfigured ${path}\n  enabled: ${name}\n`)
        // Enabling a model makes it the only enabled one, so say which backend that took
        // off. This used to be silent, and the effect is that installing a second model
        // quietly stops the first one answering -- a change nobody sees until a tool goes
        // missing from the session.
        for (const other of switched.off) {
          if (other !== name) {
            process.stdout.write(`  turned off: ${other} (onesystem use ${other} to switch back)\n`)
          }
        }
        if (needsManualCommand(backend)) {
          process.stdout.write(
            `\nONE THING LEFT: the \`command\` above is a placeholder, because ${name} ships a\n` +
              `server this installer cannot locate. Point it at the real binary in ${path}.\n`,
          )
        } else {
          process.stdout.write(`\nRun \`onesystem start\` and make a tool call. Nothing else to do.\n`)
        }
      } catch (err) {
        // The runtime is on disk and usable; only the config write failed. Saying so is
        // the difference between "it half worked" and "it did nothing".
        process.stdout.write(`\ninstalled, but the config was not updated: ${describeError(err)}\n`)
        process.stdout.write(`\nIt is on disk and usable. Add this yourself:\n${configHint(spec, runtime, backend)}\n`)
      }
    }
    if (spec.interpreterEnv) {
      process.stdout.write(
        `\n${spec.interpreterEnv} goes in the config, not your shell: the daemon inherits nothing\n` +
          `from the session that started it.\n`,
      )
    }
    return check.ok ? 0 : 1
  } catch (err) {
    process.stderr.write(`install failed: ${describeError(err)}\n`)
    return 1
  }
}

async function cmdRuntimes(): Promise<number> {
  const found = await listRuntimes()
  if (found.length === 0) {
    process.stdout.write(`no runtimes installed (looked in ${runtimesRoot()})\n`)
    return 0
  }
  for (const r of found) {
    const state = r.installed ? "ok" : "INCOMPLETE (no meta.json — safe to delete)"
    process.stdout.write(`${r.name.padEnd(10)} ${state.padEnd(34)} ${r.python}\n`)
  }
  return 0
}

async function cmdUninstall(args: string[]): Promise<number> {
  const [name] = args
  if (!name) {
    process.stderr.write("usage: onesystem uninstall <model>\n")
    return 2
  }
  const removed = await uninstall(name)
  process.stdout.write(removed ? `removed ${name}\n` : `${name} was not installed\n`)
  return 0
}

/**
 * Check an installed runtime against the GPU it would run on.
 *
 * The command that turns a silent failure loud. Every way this goes wrong — CUDA torch
 * on AMD, a venv built for the wrong interpreter, an arch torch was not built for —
 * produces a runtime that imports cleanly and then runs on the CPU, or does not, and
 * neither is obvious until you time a call.
 */
async function cmdDoctor(args: string[]): Promise<number> {
  const gpu = await detectGpu(run)
  process.stdout.write(`gpu: ${gpu.vendor}${gpu.gfx ? ` (${gpu.gfx})` : ""}\n`)
  const targets = args.length > 0 ? [args[0]!] : (await listRuntimes()).map((r) => r.name)
  if (targets.length === 0) {
    process.stdout.write("no runtimes to check\n")
    return 0
  }
  let bad = 0
  for (const name of targets) {
    const check = await verify(runtimeDir(name), gpu, run)
    if (check.ok) {
      process.stdout.write(`${name}: ok${check.torch ? ` (torch hip ${check.torch})` : ""}\n`)
    } else {
      bad++
      process.stdout.write(`${name}: FAILED\n`)
      for (const p of check.problems) process.stdout.write(`  - ${p}\n`)
    }
  }
  return bad === 0 ? 0 : 1
}

/**
 * Switch which model is live.
 *
 * A flag, not a mechanism. The daemon supervises each backend independently and the tool
 * surface namespaces itself per backend, so switching means turning one off and the other
 * on — and `enabled` already exists. What this adds is that the edit preserves the file's
 * comments and refuses to write over a concurrent change.
 */
async function cmdUse(args: string[]): Promise<number> {
  const [name] = args
  if (!name) {
    process.stderr.write("usage: onesystem use <model>\n")
    return 2
  }
  const { config, path } = await loadConfig()

  // The switch itself is `config-edit.switchToBackend`, not code in this function. It used
  // to be here, in the one command that needed it, which left the TUI's install menu with
  // no way to do the second half of what it promised.
  let switched: Awaited<ReturnType<typeof switchToBackend>>
  try {
    switched = await switchToBackend(path, config, name)
  } catch (err) {
    process.stderr.write(`${describeError(err)}\n`)
    return 1
  }

  if (!switched.changed) {
    process.stdout.write(`${name} is already the only enabled backend\n`)
    return 0
  }
  for (const n of switched.on) process.stdout.write(`on   ${n}\n`)
  for (const n of switched.off) process.stdout.write(`off  ${n}\n`)
  process.stdout.write(`\n${path} updated. Run \`onesystem start\` to pick the change up.\n`)
  return 0
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command } = parseArgs(argv)

  // Before config loading, so it still works with no config file present at all.
  if (command === "config-path") return cmdConfigPath()

  // The model commands read no config either. `install` in particular must work when the
  // config is what needs fixing, and `runtimes`/`doctor` are diagnostics you reach for
  // precisely when something is wrong.
  if (command === "install" || command === "uninstall" || command === "runtimes" || command === "doctor") {
    switch (command) {
      case "install":
        return cmdInstall(argv.slice(1))
      case "uninstall":
        return cmdUninstall(argv.slice(1))
      case "runtimes":
        return cmdRuntimes()
      default:
        return cmdDoctor(argv.slice(1))
    }
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
    case "use":
      return cmdUse(argv.slice(1))
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
      process.stderr.write(`unknown command: ${command}\n${USAGE}\n`)
      return 2
  }
}

if (import.meta.main) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code)
    },
    (err) => {
      process.stderr.write(`onesystem: ${describeError(err)}\n`)
      // `process.exit(1)` here would discard the exit code `runDaemon` set on its way out.
      // That code is a contract with `onesystem start`: 3 means "a sibling holds the lock
      // and is serving", which the caller treats as success, because the goal — a daemon
      // answering on this port — has been met by someone else. Exiting 1 instead made every
      // lost race look like a crash, so `start` reported failure for a perfectly good
      // daemon. Preserved via process.exitCode, which `exit` would otherwise overwrite.
      process.exit(process.exitCode ?? 1)
    },
  )
}
