#!/usr/bin/env bash
#
# Install onesystem: the OpenCode plugin, plus a model runtime if you want one.
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

# Bring a checkout to date: pull what is there, clone when nothing is.
bring_up_to_date() {
  if [[ -d "$1/.git" ]]; then
    step "updating $1"
    git -C "$1" pull --ff-only || warn "could not pull; continuing with what is on disk"
    ok "updated"
  else
    step "cloning into $1"
    mkdir -p "$(dirname "$1")"
    git clone --depth 1 "$REPO_URL" "$1" || die "clone failed"
    OWNS_SOURCE=1
    ok "cloned"
  fi
}

REPLY=""

# Add to SELECTED unless already there.
select_model() {
  [[ " ${SELECTED[*]} " == *" $1 "* ]] || SELECTED+=("$1")
}

# Turn an answer into SELECTED: "1, 2", "1 2", "laya julia", "a", "n". Unknown words warn.
parse_models() {
  SELECTED=()
  local input="${1,,}" token
  for token in ${input//,/ }; do
    case "$token" in
      1 | laya)  select_model laya ;;
      2 | julia) select_model julia ;;
      a | all)   select_model laya; select_model julia ;;
      "" | n | none) ;;
      *) warn "ignoring \"$token\"" ;;
    esac
  done
}

# Sets SELECTED to a model list. No terminal means none.
ask_models() {
  if [[ ! -t 0 ]]; then
    note "No terminal to ask on, so no model."
    return 0
  fi
  note "  1) laya   2) julia   a) all   n) none"
  printf '  %s? models, e.g. "1 2" or "a" [n]: ' "$YELLOW"
  read -r REPLY || REPLY=""
  parse_models "$REPLY"
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
# Empty means ask. Takes the same answers as the prompt: laya, julia, "1 2", all, none.
MODEL="${ONESYSTEM_MODEL:-}"
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

SELF_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi

# ONESYSTEM_DIR is a decision and the checkout is a default, so the variable wins.
# Both paths are printed, because stage 6 registers one of them in opencode for good.
if [[ -n "${ONESYSTEM_DIR:-}" ]]; then
  ok "using ONESYSTEM_DIR: $INSTALL_DIR"
  bring_up_to_date "$INSTALL_DIR"
elif [[ -n "$SELF_DIR" && -f "$SELF_DIR/src/cli.ts" ]]; then
  INSTALL_DIR="$SELF_DIR"
  ok "using this checkout: $INSTALL_DIR"
  note "  ONESYSTEM_DIR overrides this"
else
  bring_up_to_date "$INSTALL_DIR"
fi
DONE+=("source: $INSTALL_DIR")

# opencode keeps this path after the run, so a checkout that gets swept away breaks it.
case "$INSTALL_DIR" in
  /tmp/* | /var/tmp/*) warn "under a temp directory: opencode will keep pointing at $INSTALL_DIR" ;;
esac

cd "$INSTALL_DIR"

stage "Dependencies"

step "bun install"
bun install || die "bun install failed"
ok "dependencies installed"

stage "Config"

CONFIG_OK=1
if [[ -f "$CONFIG" ]]; then
  # A config that will not load stops every command, so check it rather than assume.
  # `status` loads the config and loads no model, and exits 2 only when the config is
  # unreadable; its stderr already names the command that repairs it.
  if problem=$(bun run src/cli.ts status 2>&1 >/dev/null); then
    ok "already there: $CONFIG"
    note "  'onesystem install' updates model paths."
  else
    CONFIG_OK=0
    warn "$CONFIG will not load:"
    printf '%s\n' "$problem" | sed 's/^/    /'
    SKIPPED+=("repair it: bun run src/cli.ts doctor --fix")
  fi
else
  mkdir -p "$CONFIG_DIR"
  cp onesystem.config.jsonc "$CONFIG"
  ok "seeded $CONFIG from the shipped template"
  DONE+=("config: $CONFIG (template)")
fi

stage "Model"

# The plugin registers and runs with no model at all, so this is a choice rather than a step.
# The download is several GB, and doing it unasked is the installer's one real overreach.
INSTALLED=$(bun run src/cli.ts runtimes 2>/dev/null | awk '$2 == "ok" { print $1 }' || true)
[[ -n "$INSTALLED" ]] && ok "already installed: $(tr '\n' ' ' <<<"$INSTALLED")"

# Installing a runtime builds it, downloads weights, and only then writes the config, so
# a config that will not load would spend several GB and fail at the last step.
if (( ! CONFIG_OK )); then
  note "not installing a model: the config has to load before one can be written."
  INSTALLED=""
else
  SELECTED=()
  if [[ -n "$MODEL" ]]; then
    parse_models "$MODEL"
  elif [[ -z "$INSTALLED" ]]; then
    ask_models
  fi

  # Already-present models are reported, not rebuilt.
  WANTED=()
  LAST=""
  for m in "${SELECTED[@]}"; do
    if grep -qx "$m" <<<"$INSTALLED"; then
      ok "$m is already installed"
    else
      WANTED+=("$m")
      LAST="$m"
    fi
  done

  if (( ${#WANTED[@]} )); then
    note "Downloads PyTorch and builds a runtime per model. Several GB each, several minutes."
    for m in "${WANTED[@]}"; do
      bun run src/cli.ts install "$m" || die "install $m failed"
      ok "$m installed and configured"
      DONE+=("model: $m")
    done
    # install enables what it installs and turns the rest off, so the last one wins.
    note "enabled: $LAST  (onesystem use <model> to switch)"
    INSTALLED="${WANTED[*]}"
  elif (( ! ${#SELECTED[@]} )); then
    if [[ -z "$INSTALLED" ]]; then
      note "no model installed. The plugin registers; its tools stay absent until you do."
      SKIPPED+=("install a model: bun run src/cli.ts install laya")
      [[ -t 0 ]] || SKIPPED+=("or set ONESYSTEM_MODEL=laya before running the installer")
    fi
  else
    note "nothing to install"
  fi
fi

stage "opencode plugin"

# Writes <opencode-config-dir>/plugins/onesystem/{index,tui}.ts, each a one-line re-export
# of the checkout. opencode discovers the directory itself, so opencode.json is not touched.
PLUGIN_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}/plugins/onesystem"
if bun run src/cli.ts register-plugin; then
  DONE+=("plugin registered in opencode's plugins directory")
else
  SKIPPED+=("add the plugin by hand: create $PLUGIN_DIR with index.ts and tui.ts")
fi

stage "Verify"

if [[ -z "$INSTALLED" ]]; then
  ok "plugin registered; no model to start"
  note "  bun run src/cli.ts install laya   then re-run this script"
else
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
fi

finish

# Preserve existing checkouts in the uninstall hint.
if (( OWNS_SOURCE )); then
  UNINSTALL="rm -rf '$INSTALL_DIR' '$CONFIG'"
else
  UNINSTALL="rm -f '$CONFIG'   # and your own checkout of onesystem, if you want it gone"
fi

if [[ -n "$INSTALLED" ]]; then
  COLD="The first tool call loads the model (~10-15s). Warm calls take tens of milliseconds."
else
  COLD="No model is installed, so the plugin has no tools yet. Install one with the command above."
fi

cat <<EOF
  ${BOLD}Restart OpenCode to load the plugin.${RESET}

  $COLD

  ${DIM}To uninstall: $UNINSTALL
  and delete $PLUGIN_DIR/.${RESET}

EOF
