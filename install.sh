#!/usr/bin/env bash
#
# onesystem installer. One command, from nothing to a model answering on the GPU.
#
#   curl -fsSL https://raw.githubusercontent.com/micahn/onesystem/master/install.sh | bash
#
# Safe to re-run. Every step checks before it acts, nothing is overwritten without asking,
# and the only thing it will not do on its own is install system packages -- that one is
# behind a prompt, because a pipe into bash has no business running sudo uninvited.
#
# Stage UX follows the /wizard conventions: progress, a confirmation gate before anything
# irreversible, and a summary at the end. The library's browser and secret helpers are
# gone: an installer opens no dashboards and captures no API keys, and the `.env` writer
# would be actively wrong here, because onesystem is configured in JSONC.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# UX. Identical across every wizard, minus the parts an installer cannot use.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
SKIPPED=()   # things the human still has to do
DONE=()      # things this run changed, for the closing summary

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages · safe to re-run · nothing is overwritten without asking%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
}

stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
ok()   { printf '  %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }

pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

die() {
  printf '\n  %s✗ %s%s\n\n' "$RED" "$1" "$RESET"
  exit 1
}

finish() {
  _clear
  printf '\n%s%s  ✓ Done%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#DONE[@]} )) && for d in "${DONE[@]}"; do note "  $d"; done
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "left for you:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=7

REPO_URL="https://github.com/micahn/onesystem.git"
# A stable location, because the plugin is registered by absolute path and a path that
# moves on the next run breaks a session that is already open. Override with ONESYSTEM_DIR.
INSTALL_DIR="${ONESYSTEM_DIR:-$HOME/.local/share/onesystem/repo}"
MODEL="${ONESYSTEM_MODEL:-laya}"
CONFIG_DIR="${ONESYSTEM_CONFIG_DIR:-$HOME/.config/onesystem}"
CONFIG="$CONFIG_DIR/onesystem.jsonc"
# Set only when this script cloned the source itself. The uninstall hint names a directory
# only when the script put it there: told to `rm -rf` a path the person chose, an installer
# deletes whatever happens to be sitting there.
OWNS_SOURCE=0

banner "onesystem installer"

# ── Stage 1: what is on this machine already ─────────────────────────────
stage "Preflight"

missing=()

command -v git >/dev/null 2>&1 || missing+=("git")
command -v curl >/dev/null 2>&1 || missing+=("curl")

if command -v bun >/dev/null 2>&1; then
  ok "bun $(bun --version)"
else
  missing+=("bun")
fi

# uv is only needed to build a model runtime, which is a later stage. Reported here so a
# missing uv is found before a several-minute download, not after.
command -v uv >/dev/null 2>&1 && ok "uv $(uv --version 2>/dev/null | head -1)" || missing+=("uv")

# `onesystem install` reads the vendor from lspci and the gfx target from rocm-smi, and
# refuses without both rather than guessing. So a missing one is a hard stop, found here
# instead of three stages from now. On NVIDIA neither is needed.
VENDOR="unknown"
if command -v lspci >/dev/null 2>&1; then
  line=$(lspci | grep -iE 'vga|3d|display' || true)
  if grep -qiE 'NVIDIA' <<<"$line"; then
    VENDOR="nvidia"
  elif grep -qiE '\b(AMD|ATI)\b' <<<"$line"; then
    VENDOR="amd"
  fi
fi

if [[ "$VENDOR" == "amd" ]]; then
  ok "GPU: AMD (lspci)"
  if [[ -x /opt/rocm/bin/rocm-smi ]] || command -v rocm-smi >/dev/null 2>&1; then
    ok "rocm-smi present"
  else
    warn "rocm-smi is missing. onesystem install reads the GPU's gfx target from it and"
    warn "refuses to guess, so a model cannot be built until it is installed."
    missing+=("rocm-core")
    [[ -d /opt/rocm/bin ]] || SKIPPED+=("add /opt/rocm/bin to your PATH, or rocm-smi stays invisible")
  fi
elif [[ "$VENDOR" == "nvidia" ]]; then
  ok "GPU: NVIDIA (lspci) · no ROCm needed"
elif [[ "$VENDOR" == "unknown" ]]; then
  warn "could not identify the GPU vendor from lspci"
  if command -v lspci >/dev/null 2>&1; then
    SKIPPED+=("install pciutils so onesystem can tell AMD from NVIDIA")
  else
    SKIPPED+=("install pciutils, then re-run: onesystem install will refuse without it")
  fi
fi

# opencode is checked here rather than at the end because a V1 host cannot load the plugin
# at all, and finding that out after a 4 GB download is the worst possible time.
OPENCODE_VER="(not found)"
if command -v opencode >/dev/null 2>&1; then
  OPENCODE_VER=$(opencode --version 2>/dev/null | head -1 || echo "(unknown)")
  ok "opencode $OPENCODE_VER"
  if [[ "$OPENCODE_VER" == *v1* ]]; then
    warn "this is opencode V1, which has no plugin API -- the tools will not appear."
    SKIPPED+=("install opencode V2 and put it first on PATH; V1 and V2 can coexist")
  fi
else
  SKIPPED+=("install opencode V2 (onesystem is a V2 plugin)")
fi

if (( ${#missing[@]} )); then
  warn "missing: ${missing[*]}"
  if command -v pacman >/dev/null 2>&1 && [[ -n "$(command -v sudo || true)" ]]; then
    step "Arch detected. Install them with:"
    note "  sudo pacman -S ${missing[*]}"
    if confirm "run that now?"; then
      sudo pacman -S --needed --noconfirm "${missing[@]}" || die "package install failed"
      ok "installed ${missing[*]}"
    else
      SKIPPED+=("sudo pacman -S ${missing[*]}")
    fi
  else
    SKIPPED+=("install: ${missing[*]}")
  fi
else
  ok "nothing missing"
fi

# ── Stage 2: the source ──────────────────────────────────────────────────
stage "Source"

# Two ways to arrive here. Run from a checkout, the script sits next to the code and uses
# it. Piped from curl, $0 is `bash` and there is no checkout, so it clones.
SELF_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi

if [[ -n "$SELF_DIR" && -f "$SELF_DIR/src/cli.ts" ]]; then
  INSTALL_DIR="$SELF_DIR"
  ok "using this checkout: $INSTALL_DIR"
  note "  set ONESYSTEM_DIR to install somewhere else"
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  step "updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || warn "could not pull; continuing with what is on disk"
  ok "updated"
else
  step "cloning into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || die "clone failed"
  OWNS_SOURCE=1
  ok "cloned"
fi
DONE+=("source: $INSTALL_DIR")

cd "$INSTALL_DIR"

# ── Stage 3: dependencies ────────────────────────────────────────────────
stage "Dependencies"

step "bun install"
bun install || die "bun install failed"
ok "dependencies installed"

# ── Stage 4: the config file ─────────────────────────────────────────────
stage "Config"

if [[ -f "$CONFIG" ]]; then
  ok "already there: $CONFIG"
  note "  left alone. 'onesystem install' fills in the paths it needs."
else
  mkdir -p "$CONFIG_DIR"
  cp onesystem.config.jsonc "$CONFIG"
  ok "seeded $CONFIG from the shipped template"
  DONE+=("config: $CONFIG (template)")
fi

# ── Stage 5: the model ───────────────────────────────────────────────────
stage "Model ($MODEL)"

if bun run src/cli.ts runtimes 2>/dev/null | grep -qE "^${MODEL}[[:space:]]+ok"; then
  ok "$MODEL runtime already installed"
else
  note "This downloads ROCm torch and builds a venv. Several minutes the first time."
  step "onesystem install $MODEL"
  # Writes the config block itself, so there is nothing to copy afterwards.
  bun run src/cli.ts install "$MODEL" || die "install $MODEL failed"
  ok "$MODEL installed and configured"
  DONE+=("model: $MODEL")
fi

# ── Stage 6: the opencode plugin ─────────────────────────────────────────
stage "opencode plugin"

# Not done with sed: opencode.json is hand-edited JSONC, and a text rewrite of a file
# whose layout nobody controls is how an install eats somebody's config. This goes through
# jsonc-parser, the same edit the rest of the project uses on its own config.
if bun run src/cli.ts register-plugin; then
  DONE+=("plugin registered in opencode's config")
else
  SKIPPED+=("add the plugin to opencode.json by hand: {\"package\": \"$INSTALL_DIR/src/plugin\"}")
fi

# ── Stage 7: check it ────────────────────────────────────────────────────
stage "Verify"

bun run src/cli.ts start >/dev/null 2>&1 || true
sleep 1
if bun run src/cli.ts status >/dev/null 2>&1; then
  ok "daemon is up and answering"
  # Deliberately not printing per-backend state. `status` emits JSON, and scraping it with
  # grep and paste produced pairs of unrelated fields: `name` and `state` are not adjacent
  # in that document. The daemon being up is the fact worth reporting, and a cold backend
  # is the expected reading anyway -- nothing loads until a request asks for it.
  note "  backends read 'cold' until a tool call asks for one, which is correct"
  note "  'bun run src/cli.ts status' prints the full picture"
else
  warn "the daemon did not come up. Run 'bun run src/cli.ts status' to see why."
  SKIPPED+=("check: bun run src/cli.ts status")
fi

finish

# Only ever name a directory this script created. Told to `rm -rf` a path the person
# chose -- a checkout, a home, a symlink target -- an installer deletes whatever is there.
if (( OWNS_SOURCE )); then
  UNINSTALL="rm -rf '$INSTALL_DIR' '$CONFIG'"
else
  UNINSTALL="rm -f '$CONFIG'   # and your own checkout of onesystem, if you want it gone"
fi

cat <<EOF
  ${BOLD}One thing left:${RESET} restart opencode. Plugins load at server start, so the
  tools do not appear in a session that is already open.

  Then ask it something. The first call loads the model and takes ~10-15s; after that it
  is tens of milliseconds.

  ${DIM}To uninstall: $UNINSTALL
  and remove the plugins entry from opencode.json.${RESET}

EOF
