# onesystem

Share one GPU decision service across OpenCode sessions. Models load on the first
request and stop when idle.

## Install

Requires OpenCode V2, Git, curl, mise, and an AMD or NVIDIA GPU. The installer
uses mise to install Bun and uv if they are missing. See
[requirements](#requirements) for GPU setup.

```sh
curl -fsSL https://raw.githubusercontent.com/micahn/onesystem/master/install.sh | bash
```

The installer clones to `~/.local/share/onesystem/repo`, installs laya, writes the
config, and registers the plugin. You can run it again to update the checkout;
it skips installed runtimes and asks before running `sudo`.

Restart OpenCode, then run `opencode plugin list` to check that `onesystem` loaded.
The first tool call loads the model. Warm calls take tens of milliseconds.

[Manual install](#manual-install) · [Julia or a custom path](#installer-options) ·
[Existing laya setup](#existing-laya-setup)

## Use

The plugin starts the shared daemon as needed. To run commands yourself, open the
checkout:

```sh
cd ~/.local/share/onesystem/repo
bun run src/cli.ts status
```

Use `bun run src/cli.ts <command>` for each command below. If you have added the
package's CLI to `PATH`, you can use `onesystem <command>` instead.

| Command | Action |
| --- | --- |
| `start` | Start the daemon if needed. Safe across concurrent sessions. |
| `status` | Show status as JSON without loading a model. |
| `stop` | Stop the daemon and its local backends. |
| `serve` | Run the daemon in the foreground. |
| `runtimes` | List installed runtimes. |
| `doctor [model]` | Check an installed runtime against the GPU. |
| `install <model>` | Install laya or julia and enable it. |
| `use <model>` | Enable one configured backend and disable the others. |
| `uninstall <model>` | Remove its runtime. Keep downloaded weights. |
| `config-path` | Show the config path. |
| `register-plugin` | Register this checkout with OpenCode. |

Installing or selecting a model disables the other backends. After a config change,
stop the daemon and restart OpenCode to reload the config and tool names.

Logs: `~/.local/state/onesystem/daemon.log`.

## How it works

```text
OpenCode sessions -> plugin -> shared HTTP daemon -> local MCP process -> GPU
                                                -> existing HTTP service
```

- The plugin registers native tools from `GET /catalog` and sends calls to `POST /call`.
- Startup and status checks load no model. The first backend request starts the process.
- An atomic file lock and the listening port prevent duplicate daemons.
- After 600 seconds idle, local backends stop. Once all are cold, a previously used
  daemon exits. The plugin starts it again before the next tool call.
- Closing one session leaves the shared daemon running for the others.

Other clients can use MCP Streamable HTTP at `/mcp/<backend>`.

## Configuration

Edit `~/.config/onesystem/onesystem.jsonc`. The `.json` filename also works.
See the [annotated template](onesystem.config.jsonc) for backend examples.
Its paths are placeholders; `install <model>` writes the real paths.

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Loopback only; the service has no authentication. |
| `port` | `7331` | HTTP port. |
| `idleShutdownSecs` | `600` | Stop an idle local backend after this many seconds. |
| `idleSweepSecs` | `5` | Seconds between idle checks. Must not exceed the idle window. |
| `requestTimeoutSecs` | `120` | Maximum seconds for a forwarded call. |
| `backends` | `{}` | Backend definitions. |

### Backends and tools

- `stdio-mcp`: onesystem starts and stops a local MCP process. Used by laya and julia.
- `systemone-http`: forwards a `systemone` tool to an existing `POST /v1/systemone`
  service, such as rev. Start that service separately. The adapter passes the body
  through; its schema has not been checked against a live service.

Each `stdio-mcp` backend must declare `tools` without its `toolPrefix`. The daemon
serves this list without starting the model. Update it when a backend adds or renames
tools. MCP `tools/list` returns the backend's actual schemas but starts the process.

The plugin strips `toolPrefix` from displayed names. With one backend, tools use
names such as `predict`. With several, they use `laya_predict` and `julia_predict`.
Enable `routing` and set its `default` to let one backend keep unqualified names.
Routing only applies with multiple backends; `routing.tasks` provides logged guidance,
not automatic dispatch. `serverName` overrides the server name in status reports.

For laya, keep `LAYA_PRELOAD: "0"` to load weights only on use. Put `LAYA_PYTHON`
in the backend's `env` when its command needs an explicit interpreter. The installed
`laya-mcp-server` uses its own virtual environment's interpreter.

## Install options

### Requirements

- OpenCode V2. Check `opencode --version`. If mise still selects V1, put the V2
  binary first on `PATH`. This plugin uses the V2 API.
- Git, curl, and mise. Bun and uv are installed with `mise use -g bun uv` when
  they are missing, so the installer stops if mise is not on `PATH`.
- `lspci` from `pciutils` to detect the GPU vendor.
- For AMD, ROCm and `rocm-smi` on `PATH`. NVIDIA uses the CUDA install path and
  does not need ROCm.

On Arch or Omarchy, install the AMD detection tools:

```sh
sudo pacman -S pciutils rocm-core
export PATH=/opt/rocm/bin:$PATH
rocm-smi --showproductname
```

The last command must print a GFX Version. The installer stops if it cannot identify
the GPU or the AMD target. The first runtime install takes several minutes, mostly
to download PyTorch.

### Installer options

Set these variables before running the curl command:

| Variable | Default | Use |
| --- | --- | --- |
| `ONESYSTEM_MODEL` | `laya` | Set to `julia` to install julia. |
| `ONESYSTEM_DIR` | `~/.local/share/onesystem/repo` | Choose the checkout path for a curl install. |

For example, run `export ONESYSTEM_MODEL=julia`, then run the install command.
Running `bash install.sh` from a checkout uses that checkout.

### Manual install

Check the [requirements](#requirements), then:

```sh
git clone https://github.com/micahn/onesystem.git
cd onesystem
bun install
mkdir -p ~/.config/onesystem
cp -n onesystem.config.jsonc ~/.config/onesystem/onesystem.jsonc
bun run src/cli.ts install laya
bun run src/cli.ts register-plugin
bun run src/cli.ts start
bun run src/cli.ts status
```

Use `install julia` for julia. Add `--no-config` to print the config block instead
of writing it, or `--lock-only` to resolve dependencies without installing the runtime.
Backends should show `cold` until the first call.

Registration writes `~/.config/opencode/plugins/onesystem.ts`, which re-exports the
plugin from this checkout. Keep the checkout at that path. Updates take effect when
OpenCode reloads the plugin. Registration also removes the old `plugins` array entry
from `opencode.json` to prevent duplicate loading.

Restart OpenCode and check `opencode plugin list`.

### Existing laya setup

Remove the old local `laya-mcp` entry from `mcp.servers` in `opencode.json`.
Otherwise, sessions still start separate laya processes alongside the shared daemon.

## Development

```sh
bun test
bun run typecheck
```

Tests use fake backends and need no GPU. For an AMD/ROCm check, install the laya
runtime and run `./test/e2e-laya.sh`. It stops and starts the daemon on port 7331,
so run it when no active session needs the service.

### Measured performance

AMD RX 9070 XT (gfx1201), ROCm 6.4 driver, ROCm 7.2 PyTorch wheel, laya 0.3.21:

| Operation | Time or memory |
| --- | --- |
| Install laya, warm uv cache | ~10 s |
| Install julia, including 585 MB of weights | ~46 s |
| Start daemon, no model loaded | ~190 ms |
| First tool call | laya ~13.7 s; julia ~15.7 s |
| Warm tool call | Tens of milliseconds |
| Both models loaded | 6.6 GB VRAM |

Cold calls spend most of their time importing `transformers`.
