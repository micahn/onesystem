#!/usr/bin/env bash
#
# Install onesystem and a GPU model runtime.
#
#   curl -fsSL https://raw.githubusercontent.com/micahn/onesystem/master/install.sh | bash
#
# Re-runs update the checkout and skip installed runtimes. Ask before running sudo.

set -euo pipefail

# Terminal helpers

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Set before the first stage.
TOTAL_STAGES=0

_STAGE_INDEX=0
SKIPPED=()   # things the human still has to do
DONE=()      # things this run changed, for the closing summary

# Clear terminals only; preserve piped logs.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages · asks before running sudo%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
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

# Install stages

TOTAL_STAGES=7

REPO_URL="https://github.com/micahn/onesystem.git"
# Keep this path stable: plugin registration uses an absolute path.
INSTALL_DIR="${ONESYSTEM_DIR:-$HOME/.local/share/onesystem/repo}"
MODEL="${ONESYSTEM_MODEL:-laya}"
CONFIG_DIR="${ONESYSTEM_CONFIG_DIR:-$HOME/.config/onesystem}"
CONFIG="$CONFIG_DIR/onesystem.jsonc"
# Only suggest deleting source that this run cloned.
OWNS_SOURCE=0

banner "onesystem installer"

stage "Preflight"

missing=()

command -v git >/dev/null 2>&1 || missing+=("git")
command -v curl >/dev/null 2>&1 || missing+=("curl")

# Install bun and uv through mise, which is guaranteed here. It needs no sudo, and
# it is the tool this project already tells people to use.
absent=()
for tool in bun uv; do
  command -v "$tool" >/dev/null 2>&1 || absent+=("$tool")
done
if (( ${#absent[@]} )); then
  if command -v mise >/dev/null 2>&1; then
    step "mise install ${absent[*]}"
    mise use -g "${absent[@]}" >/dev/null 2>&1 || warn "mise could not install ${absent[*]}"
    # Shims only reach a new shell after mise activates; the installer cannot
    # modify its own PATH back in, so add them here.
    shims="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"
    [[ -d "$shims" ]] && PATH="$shims:$PATH"
  else
    die "mise is required to install ${absent[*]}, and it is not on PATH"
  fi
fi

command -v bun >/dev/null 2>&1 && ok "bun $(bun --version)" || missing+=("bun")
command -v uv >/dev/null 2>&1 && ok "uv $(uv --version 2>/dev/null | head -1)" || missing+=("uv")

# Detect the vendor with lspci. AMD also needs rocm-smi for its gfx target.
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
    warn "Install rocm-smi to detect the AMD GPU target."
    missing+=("rocm-core")
    [[ -d /opt/rocm/bin ]] || SKIPPED+=("add /opt/rocm/bin to PATH")
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

# Check the plugin host before downloading model dependencies.
OPENCODE_VER="(not found)"
if command -v opencode >/dev/null 2>&1; then
  OPENCODE_VER=$(opencode --version 2>/dev/null | head -1 || echo "(unknown)")
  ok "opencode $OPENCODE_VER"
  if [[ "$OPENCODE_VER" == *v1* ]]; then
    warn "This plugin requires OpenCode V2."
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

stage "Source"

# Use the script's checkout, or clone when piped from curl.
SELF_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi

if [[ -n "$SELF_DIR" && -f "$SELF_DIR/src/cli.ts" ]]; then
  INSTALL_DIR="$SELF_DIR"
  ok "using this checkout: $INSTALL_DIR"
  note "  curl installs use ONESYSTEM_DIR to choose the checkout path"
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

stage "Dependencies"

step "bun install"
bun install || die "bun install failed"
ok "dependencies installed"

stage "Config"

if [[ -f "$CONFIG" ]]; then
  ok "already there: $CONFIG"
  note "  'onesystem install' updates model paths."
else
  mkdir -p "$CONFIG_DIR"
  cp onesystem.config.jsonc "$CONFIG"
  ok "seeded $CONFIG from the shipped template"
  DONE+=("config: $CONFIG (template)")
fi

stage "Model ($MODEL)"

if bun run src/cli.ts runtimes 2>/dev/null | grep -qE "^${MODEL}[[:space:]]+ok"; then
  ok "$MODEL runtime already installed"
else
  note "Downloads PyTorch and builds a runtime. Allow several minutes."
  step "onesystem install $MODEL"
  bun run src/cli.ts install "$MODEL" || die "install $MODEL failed"
  ok "$MODEL installed and configured"
  DONE+=("model: $MODEL")
fi

stage "opencode plugin"

# Register a re-export so checkout updates take effect on plugin reload.
if bun run src/cli.ts register-plugin; then
  DONE+=("plugin registered in opencode's plugins directory")
else
  SKIPPED+=("add the plugin by hand: create ~/.config/opencode/plugins/onesystem.ts")
fi

stage "Verify"

bun run src/cli.ts start >/dev/null 2>&1 || true
sleep 1
if bun run src/cli.ts status >/dev/null 2>&1; then
  ok "daemon is up and answering"
  note "  backends stay 'cold' until the first tool call"
  note "  details: bun run src/cli.ts status"
else
  warn "the daemon did not come up. Run 'bun run src/cli.ts status' to see why."
  SKIPPED+=("check: bun run src/cli.ts status")
fi

finish

# Preserve existing checkouts in the uninstall hint.
if (( OWNS_SOURCE )); then
  UNINSTALL="rm -rf '$INSTALL_DIR' '$CONFIG'"
else
  UNINSTALL="rm -f '$CONFIG'   # and your own checkout of onesystem, if you want it gone"
fi

cat <<EOF
  ${BOLD}Restart OpenCode to load the plugin.${RESET}

  The first tool call loads the model (~10-15s). Warm calls take tens of milliseconds.

  ${DIM}To uninstall: $UNINSTALL
  and delete ~/.config/opencode/plugins/onesystem.ts.${RESET}

EOF
