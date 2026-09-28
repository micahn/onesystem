/**
 * Where things live on disk.
 *
 * Path layout was the least interesting thing in `config.ts` and the thing that made the
 * module widest: `daemon.ts` wanted `lockPath()` and had to import the module that also owns
 * the loopback security policy, the transport union, the port-zero allowance and the status
 * schema. Nothing about finding a lock file requires a validator to exist.
 *
 * So it is here, importing nothing from the project. That is not tidiness — it is what lets
 * `config.ts` import from here without a cycle, since `loadConfig` needs `configCandidates`
 * and this module must not need `Config`.
 *
 * `daemonUrl` moved here too, and with it the reason it is worth being in one place: `http.ts`
 * carried a *second*, private copy of it, with a comment pointing at this one and calling
 * itself "the one place a daemon's address is assembled". Two implementations of the string
 * a client dials, differing in nothing that matters until one of them is edited.
 */

import { homedir } from "node:os"
import { join } from "node:path"

export function configDir(): string {
  return process.env.ONESYSTEM_CONFIG_DIR ?? join(homedir(), ".config", "onesystem")
}

export function stateDir(): string {
  return process.env.ONESYSTEM_STATE_DIR ?? join(homedir(), ".local", "state", "onesystem")
}

export function lockPath(): string {
  return join(stateDir(), "daemon.lock")
}

export function defaultConfigPath(): string {
  return join(configDir(), "onesystem.json")
}

/** Where a bundled example lives, used when the user has no config yet. */
export function shippedConfigPath(): string {
  return new URL("../onesystem.config.json", import.meta.url).pathname
}

/**
 * Every path `loadConfig` would try, in order.
 *
 * The first is what a person means by "my onesystem config"; the second is the bundled
 * example, so a fresh checkout runs without being told where anything is. `config-path`
 * prints all of them with which one is in use, because the old helper returned only the
 * first and claimed to be "the config file that would be used" — which is false for
 * exactly the users most likely to run it, those with no config file yet.
 *
 * An explicit `path` replaces the list rather than joining it: a caller who names a file
 * means that file, and quietly also reading the bundled example would be a second answer to
 * a question they thought they had answered.
 */
export function configCandidates(path?: string): string[] {
  return path ? [path] : [defaultConfigPath(), shippedConfigPath()]
}

/**
 * The daemon's base URL. Assembled once.
 *
 * This was built in three places from a `Config` — here, in the CLI, and in the plugin
 * from environment variables no daemon code reads — so a user who set `port` in the config
 * and a user who set `ONESYSTEM_PORT` got two daemons' worth of disagreement, and the
 * symptom was an MCP server registered against a port nothing was listening on. The
 * plugin now reads the URL out of `onesystem status` instead of deriving one.
 *
 * Takes a host and a port rather than a `Config`, which is the smaller interface and the
 * one that let `http.ts` use this instead of keeping its own copy. It cannot import `Config`
 * for that: `config.ts` needs `configCandidates` from this module, and an address builder
 * that needs the whole configuration is an address builder that is hard to test.
 */
export function daemonUrl(host: string, port: number): string {
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `http://${bracketed}:${port}`
}
