# onesystem

One shared System 1 decision service on the GPU, fronted over HTTP, shared by every
opencode session.

## Why this exists

The setup this replaces had three problems, all measured on this machine.

**Every session loaded its own copy of the model.** opencode spawns one MCP server per
session directory. With laya configured as a local stdio server, eight open sessions
meant eight processes, each holding a checkpoint — roughly 3 GB of VRAM and a cold start
each, for one shared model.

**The cold start looked like a CPU fallback.** A fresh session blocked 20-54s on the
first `laya_predict`. The work was all on the GPU; the process was simply silent while
importing `transformers` (25-30s) and then loading the checkpoint. The venv carries the
ROCm torch build and the mise interpreter does not, so a wrong interpreter degrades to
CPU *silently* — which is exactly how this was first misdiagnosed.

**Editing the MCP config dropped in-flight calls.** opencode reconnects every MCP server
when the config changes, so a hand-edit mid-session kills the `laya_predict` that other
sessions are waiting on.

onesystem fixes all three by making the model a single shared resource with one owner.

## How it works

```
  opencode session A ─┐
 opencode session B ─┼─→ plugin ──→ onesystem daemon ──→ laya (stdio MCP)  ──→ GPU
 opencode session C ─┘   (V2)         (one, locked)  └─→ rev  (systemone-http)

Tools are exposed as `onesystem.<tool>`: `onesystem.predict`, `onesystem.route`,
`onesystem.status`, `onesystem.preset`.
```

- The **plugin** runs in every session. It ensures one daemon is up and registers one
  remote MCP server per backend. It never loads a model.
- The **daemon** owns the process. It takes an exclusive lock, binds a loopback port, and
  fronts each backend as MCP over Streamable HTTP.
- The **backend** is the only thing that touches the GPU, and only when a request arrives.

## The two properties that matter

**Loading the plugin costs plugin memory and nothing else.** The daemon binds its port
and answers `/health` before any model exists. `onesystem start` returns in ~190ms and
spawns no model process. The first `tools/call` is what pays the load.

**Nothing can start a second instance.** Many sessions load the plugin simultaneously and
all of them decide the service is down. `src/lock.ts` resolves that with
`open(path, "wx")`, which the kernel makes atomic, so exactly one process creates the
lock file and the rest are told who holds it. The TCP bind is a second, independent layer:
if the lock file is ever lost, only one process can own the port, so a duplicate fails
loudly instead of quietly doubling VRAM usage.

This is not theoretical. A leftover daemon from a failed test run held the lock during
development, and the next `onesystem start` refused to start — which is the behaviour
working, not a bug.

## Install

Requires [bun](https://bun.sh) and [uv](https://docs.astral.sh/uv/). uv is only needed for
`onesystem install`; bun runs everything else.

```sh
bun install
mkdir -p ~/.config/onesystem
cp onesystem.config.json ~/.config/onesystem/onesystem.json
```

That config is a **template, not a working file.** Every path in it is a placeholder
(`/path/to/...`, `/home/you/...`), because the real ones depend on your interpreter and your
weights directory and cannot be written down in a repository. The installer is what fills
them in:

```sh
onesystem install laya    # builds the runtime, then prints the exact block for your machine
onesystem use laya        # and switches the config to it
```

Skipping this is the most likely way to fail on a first run. A placeholder `command` path
does not fail loudly at start: the daemon accepts the connection and answers, then returns
an error payload on the first `tools/call`, and `onesystem status` reports the backend as
failed to start with the placeholder in the message. Nothing is wrong except the path.

`onesystem install` needs a GPU it can identify. It reads the vendor from `lspci` and the
gfx target from `rocm-smi`, and refuses rather than guessing, so an unsupported or
undetectable card stops the install instead of quietly producing a CPU-only runtime.

Then in `~/.config/opencode/opencode.json`, register the plugin and **remove** the old
per-session stdio entry:

```jsonc
{
  "plugins": [{ "package": "/path/to/onesystem/src/plugin" }],
  "mcp": { "servers": { /* delete the old "laya-mcp" local entry */ } }
}
```

`package` must be the **directory**, not the `index.ts` file. Pointing it at the file
fails with `configured plugin path must be a directory` in
`~/.local/share/opencode/log/opencode.log`, and the session ends up with no `laya` tools
and no other symptom. opencode resolves the entrypoint inside the directory itself.

Removing the old entry is the part that matters. It is a `type: "local"` stdio server, so
as long as it is configured, every session keeps its own laya process and its own copy of
the checkpoint — which is the entire problem this project exists to solve. The plugin
registers `laya` itself, over HTTP, sharing one daemon.

The plugin needs no options: it derives the CLI path from its own location, so it works
from a checkout with nothing on `PATH`. Override via `options` for a specific executable
or different timeouts.

**Restart opencode after this change.** Plugins load at server startup; editing the config
reconnects MCP servers but does not load a newly added plugin. Until you restart, the
session has no `laya` tools at all.

## Use

```sh
onesystem start     # start the daemon if it is not already up (race-safe)
onesystem status    # what is running; loads nothing
onesystem stop      # stop it now
onesystem serve     # run in the foreground
```

And the model commands, which read no config and so work even when the config is what is
broken:

```sh
onesystem runtimes            # which runtimes are installed
onesystem doctor [model]      # check one against the GPU it will run on
onesystem install <model>     # build a runtime onesystem owns
onesystem use <model>         # switch which backend is enabled
onesystem uninstall <model>
onesystem config-path
```

Logs go to `~/.local/state/onesystem/daemon.log`.

## Configuration

`~/.config/onesystem/onesystem.json`, JSONC. See `onesystem.config.json` for the annotated
version.

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Loopback only. Do not change without adding auth. |
| `port` | `7331` | |
| `idleShutdownSecs` | `600` | Wind down after this long with no traffic. |
| `idleSweepSecs` | `5` | How often the idle check runs. |
| `requestTimeoutSecs` | `120` | Ceiling on one forwarded call. |
| `backends` | `{}` | See below. |

### The declared tool surface

Every `stdio-mcp` backend needs a `tools` list naming the tools it exposes, without its
product prefix. This is the one place a model's surface is written down by hand:

```jsonc
"laya": {
  "transport": "stdio-mcp",
  "command": ["/path/to/bin/laya-mcp-idle-server"],
  "toolPrefix": "laya_",
  "tools": ["predict", "status", "route", "decide"]
}
```

It is declared because it cannot be discovered. Reading the tool list means forwarding
`tools/list` to the process, and that is the 20-54s load and 3 GB of VRAM that lazy start
exists to keep off session start — so a session that discovered its own tools would load
every model before the agent asked anything. The daemon serves the declared list from
`/catalog` without touching a process.

The trade is real: if a model adds or renames a tool, the list needs a matching edit. A
name the process does not answer fails the call with the backend's own "unknown tool",
which is loud at the moment of the call — the preferable failure to a session start that
quietly costs three gigabytes. After a first call, `onesystem status` shows what the
model actually publishes.

### Naming

The MCP server is registered as `onesystem`, and each backend's `toolPrefix` is stripped
from its tool names, so laya's `laya_predict` is presented as `onesystem.predict`. The
rename happens in both directions: stripped on the way out to opencode, restored on the
way in to the process. Doing it in one direction only would advertise a name the backend
cannot answer to.

`toolPrefix` is explicit rather than inferred. The daemon has no way to know that a
backend happens to prefix its tools with its own product name, and a wrong guess would
silently rename every tool.

With one backend enabled the server is named `onesystem`. With several, they become
`onesystem-<backend>` so two backends cannot claim the same name; set `serverName`
explicitly to override.

### Backends

Two transports, because the System 1 landscape does not agree on one.

**`stdio-mcp`** — a local process speaking MCP over stdio. onesystem owns the process.
This is `laya`.

```jsonc
"laya": {
  "transport": "stdio-mcp",
  "command": ["/path/to/bin/laya-mcp-idle-server"],
  "env": { "LAYA_DEVICE": "cuda", "LAYA_PYTHON": "/path/to/venv/bin/python" },
  "startupTimeoutSecs": 180
}
```

> **`LAYA_PYTHON` is not optional.** The shim reads it from its own environment, and it
> is not inherited from your shell — it only exists inside opencode's MCP config. Omit
> it and the shim falls back to the mise interpreter, cannot import laya, and dies on
> startup. Because the daemon keeps answering, that failure shows up as error payloads
> rather than a dead service, so it is worth setting explicitly.

**`systemone-http`** — an already-running service speaking `POST /v1/systemone`, the spec
behind TypeSafe's `typesafe-sdk` and implemented by `rev`. onesystem does not start these.

```jsonc
"rev": { "transport": "systemone-http", "baseUrl": "http://127.0.0.1:8000" }
```

Adding a model is a config entry, not a code change. As of September 2026 the open
System 1 field includes `laya`, `rev`, `foq`, `rush-one`, `system1`, and
`FastDecider-149M`, with `Jev` as the closed commercial equivalent. Anything speaking
`/v1/systemone` drops in as an HTTP backend; anything speaking MCP over stdio drops in as
a process backend.

> The `systemone-http` adapter deliberately exposes one pass-through `systemone` tool
> rather than a typed `predict`. The exact `/v1/systemone` schema is not verified against
> a live service here, and inventing field names that silently do nothing would be worse
> than an honest pass-through. Replace `forward()` with a typed adapter once there is a
> real service to read the schema from; the transport and lifecycle do not change.

## Lifecycle

| Event | What happens |
| --- | --- |
| Plugin loads | `onesystem start`, then register remote MCP servers. No model. |
| First `tools/call` | Backend spawns. Costs 10-54s and ~3 GB VRAM. |
| Idle for `idleShutdownSecs` | Backend stops; when nothing is warm the daemon exits. |
| Next `tools/call` after that | Plugin notices nothing is listening and restarts the daemon first. |
| Session closes | Registration dropped. **Daemon left running** — see below. |
| Catalog changes | opencode caches tool names per session, so a rename needs a session restart. |
| `onesystem stop` | Everything stops now. |

A session closing does not stop the daemon. Sessions close independently, so one closing
must not pull the model out from under the others. The idle window is what ends it, and
`onesystem stop` is there for when you want it gone immediately.

A session routinely outlives the idle window, and opencode holds no handle on the daemon
process — the tools stay in the session catalog, so the agent keeps calling them against a
port nothing is listening on. So the plugin hooks `tool.execute.before`: a call to one of
its own servers probes `/health` first, and starts the daemon if nothing answers. The call
pays about a second of startup rather than failing, and the session's MCP client is
reloaded so it drops the session id of the daemon that exited. Deliberately not a poll: a
timer would either hold the daemon open forever or sit on an interval long enough to be
the same bug. The GPU is still released the moment the window closes; only the process
comes back, and it comes back cold.

## Timeouts

There is one request budget, `requestTimeoutSecs`, enforced by the supervisor on the
daemon side and passed down to the adapter so it can hand the same number to a library
that wants one. opencode's MCP startup timeout does not apply: the plugin registers
tools natively rather than as remote MCP servers, so nothing is negotiated at connect
time and no host timeout has to be extended to cover a cold load.

`GET /catalog` — the one call the plugin makes at setup — loads nothing and is bounded
inside the plugin, so a daemon that accepts a connection and then stops answering cannot
hold session start open.

## Tests

```sh
bun test              # 279 unit and integration tests
./test/e2e-laya.sh    # end to end against the real laya backend
```

`bun test` is self-contained: the backend tests run against fake MCP processes in
`test/fixtures/`, so they need no GPU and no model. `e2e-laya.sh` is the opposite. It wants
a real AMD or NVIDIA card, a `laya` runtime from `onesystem install laya`, and the laya MCP
shim on `PATH` under the name `laya-mcp-idle-server`, which is not part of this repository.
It also stops and starts the daemon on port 7331, so do not run it against a session you are
using.

The tests worth knowing about:

- **`lock.test.ts`** fires 25 concurrent acquires and asserts exactly one wins. This
  caught a real bug: `open(path, "wx")` creates the file *empty*, and a loser reading it
  inside that window saw no pid, called it stale, and deleted it. Two daemons, one lock.
  Fixed with a grace window that treats an unreadable record as a create in flight.
- **`lazy.test.ts`** starts a real daemon against a real MCP child and watches a marker
  file the child writes on spawn. This is what pins "nothing loads until the first
  request", and it pins it twice over: once for `GET /catalog` and once for the whole
  plugin setup path, which are the two things that used to spawn a model before the agent
  had asked anything. It also caught a second real bug: `#everWarm` was set while reading
  backend state *before* the forward, where a first request always looks cold, so a
  service that only ever saw one request never shut down.
- **`e2e-laya.sh`** asserts `device: cuda` explicitly. Asserting on timing is not enough;
  an early version passed while every call was failing, because the shim had died on a
  missing `LAYA_PYTHON` and the bridge returned error payloads quickly.

## Measured

On this machine (AMD GPU, ROCm 6.4, `laya` 0.3.21):

| | |
| --- | --- |
| `onesystem start` → healthy | ~190 ms, no model |
| First `tools/call` (cold) | ~10-14 s |
| Warm `tools/call` | ~32 ms |
| VRAM per loaded checkpoint | ~3 GB |

## Layout

```
src/
  cli.ts                serve | start | stop | status | install | use | doctor
  daemon.ts             lock + bind + supervise + wind down
  lock.ts               single-instance guard
  http.ts               MCP Streamable HTTP front
  health.ts             what GET /health means, and how to read it
  supervisor.ts         lazy start, request accounting, idle shutdown
  config.ts             JSONC config, validation
  config-edit.ts        editing that config without destroying the comments
  routing.ts            which model answers when the agent has not said
  naming.ts             what a backend and its tools are called
  models.ts             the models onesystem knows how to install
  install.ts            installing a model: a Python environment onesystem owns
  paths.ts              where things live on disk
  subprocess.ts         the project's one subprocess seam
  async.ts              deadlines and error description, shared by everything that waits
  log.ts                structured logging
  version.ts
  backend/
    spec.ts             what a backend is, as declared in config
    types.ts            the Backend contract, and the port the daemon depends on
    stdio-mcp.ts        spawn + forward to a local MCP process
    systemone-http.ts   POST /v1/systemone
    usage.ts            per-backend call accounting
  plugin/
    index.ts            the opencode V2 plugin
    discover.ts         finding the daemon, from either entrypoint
    tools.ts            registering the models as native tools
    tui.ts              the status line, and a way to fix what it says
  shims/
    julia-mcp.py        MCP bridge for julia, which ships a library and no server
```
