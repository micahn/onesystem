#!/usr/bin/env bash
# End-to-end check against the real laya backend.
#
# The property being verified is the one the project exists for: starting the service
# loads nothing, the first request loads exactly one copy, and stopping releases it.
# Every step prints the observable it cares about so a failure says which claim broke.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=7331
URL="http://127.0.0.1:${PORT}"
CLI="bun run src/cli.ts"

vram() { rocm-smi --showmeminfo vram 2>/dev/null | grep -oP 'Used Memory \(B\): \K[0-9]+'; }
mb() { echo "$(( $1 / 1024 / 1024 )) MB"; }

# Count only the laya processes onesystem itself owns, as children of the daemon.
# A global `pgrep -f laya` is not a usable signal here: opencode keeps its own per-session
# laya servers alive, and they load and idle-unload on a 300s timer, so the global count
# moves underneath the test for reasons that have nothing to do with onesystem.
owned_laya() {
  local dpid
  dpid=$(curl -s --max-time 2 "${URL}/health" 2>/dev/null | sed 's/\\//g' | grep -oP '"pid":\s*\K[0-9]+' | head -1)
  [ -z "$dpid" ] && { echo 0; return; }
  pgrep -P "$dpid" -f laya-mcp-server 2>/dev/null | wc -l
}

# Always start from a known state. A previous run that died mid-way leaves a daemon
# holding the lock, and the next `start` will (correctly) refuse to start a second one.
echo "=== pre-flight: stop any existing daemon ==="
$CLI stop 2>&1 | tail -2
sleep 1

post() { # post <json> [session-id]
  curl -s -X POST "${URL}/mcp/laya" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    ${2:+-H "mcp-session-id: $2"} \
    -d "$1"
}

# MCP answers over Streamable HTTP arrive as an SSE frame whose `data:` line holds
# escaped JSON, so `"device": "cpu"` is really `\"device\": \"cpu\"`. Strip the
# escaping before matching, otherwise every content assertion silently misses.
flat() { sed 's/\\//g'; }

echo "=== baseline ==="
V0=$(vram)
echo "VRAM $(mb "$V0")   ambient laya procs $(pgrep -f laya-mcp-server | wc -l)"

echo
echo "=== onesystem start (must NOT load a model) ==="
START=$(date +%s%N)
$CLI start 2>&1 | tail -3
echo "start returned in $(( ($(date +%s%N) - START) / 1000000 ))ms"
sleep 2
V1=$(vram); L1=$(owned_laya)
echo "VRAM $(mb "$V1")   onesystem-owned laya procs $L1"
if [ "$L1" -ne 0 ]; then echo "FAIL: start spawned laya ($L1); it must stay lazy"; exit 1; else echo "OK: no laya process spawned"; fi

echo
echo "=== GET /catalog (must NOT load a model either) ==="
# The one endpoint that used to break the invariant. The plugin reads this at session
# start to learn the tool surface, and it used to forward `tools/list` to each backend --
# so opening a session loaded every model before the agent asked anything. The surface is
# declared in config now and read from there.
CAT=$(curl -s --max-time 5 "${URL}/catalog")
echo "catalog tools: $(echo "$CAT" | sed 's/\\//g' | grep -oP '"name":\s*"\K[^"]+' | tr '\n' ' ')"
V_CAT=$(vram); L_CAT=$(owned_laya)
echo "VRAM $(mb "$V_CAT")   onesystem-owned laya procs $L_CAT"
if [ "$L_CAT" -ne 0 ]; then
  echo "FAIL: /catalog spawned laya ($L_CAT); session start must not load a model"
  exit 1
else
  echo "OK: /catalog loaded nothing"
fi

echo
echo "=== health (backend must be cold) ==="
curl -s "${URL}/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("anyLocalWarm:", d["anyLocalWarm"]); [print(" ", b["name"], b["state"]) for b in d["backends"]]'

echo
echo "=== cold MCP handshake + predict (this is where the model loads) ==="
INIT=$(post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}')
SID=$(echo "$INIT" | grep -oiP 'mcp-session-id: \K[0-9a-f-]+' | head -1)
[ -z "$SID" ] && SID=$(curl -s -D - -o /dev/null -X POST "${URL}/mcp/laya" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}' | grep -oiP 'mcp-session-id: \K[0-9a-f-]+' | head -1)
echo "session: ${SID:-<none>}"
post '{"jsonrpc":"2.0","method":"notifications/initialized"}' "$SID" >/dev/null

T0=$(date +%s%N)
TOOLS=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$SID")
echo "tools/list in $(( ($(date +%s%N) - T0) / 1000000 ))ms"
# Assert on content, not timing. An earlier version of this script passed while every
# call was failing: the shim had died on a missing LAYA_PYTHON, the bridge returned
# error payloads fast, and nothing here looked at the body.
#
# The names here are the *stripped* ones, because that is what the bridge hands
# opencode: the `laya_` prefix is removed on the way out and put back on the way in, so
# the wire name is `predict`. This script used to grep for `laya_predict` here and call
# `laya_predict` below, which stopped being true when the stripping was added -- and the
# call then failed as "Unknown tool: laya_laya_predict", the bridge having helpfully
# prefixed an already-prefixed name.
if ! echo "$TOOLS" | grep -q '"name":"predict"'; then
  echo "FAIL: tools/list did not return the predict tool. Body was:"
  echo "$TOOLS" | head -c 600; echo
  echo "--- daemon log ---"; tail -20 "${HOME}/.local/state/onesystem/daemon.log"
  exit 1
fi
echo "OK: tools = $(echo "$TOOLS" | grep -oP '"name":"\K[^"]+' | sort -u | tr '\n' ' ')"

sleep 2
V2=$(vram); L2=$(owned_laya)
echo "VRAM $(mb "$V2")   onesystem-owned laya procs $L2"
if [ "$L2" -eq 1 ]; then echo "OK: exactly one laya process"; else echo "FAIL: expected 1 owned laya proc, got $L2"; exit 1; fi

T1=$(date +%s%N)
PRED=$(post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"predict","arguments":{"state":{"situation":"Choosing between two refactor options for a parser."},"questions":{"q":{"type":"choice","instructions":"Which is better?","criteria":{"a":"Split into named helpers","b":"Keep inline with comments"}}}}}}' "$SID")
echo "predict in $(( ($(date +%s%N) - T1) / 1000000 ))ms"
if ! echo "$PRED" | flat | grep -q '"choice"'; then
  echo "FAIL: predict returned no answer. Body was:"; echo "$PRED" | head -c 600; echo; exit 1
fi
# device must be cuda. A cpu here is the exact silent-fallback failure this project
# was built to end, so it is asserted rather than eyeballed.
echo "device: $(echo "$PRED" | flat | grep -oP '"device":\s*"[^"]*"' | head -1)"
echo "$PRED" | flat | grep -oP '"choice":\s*"[^"]*"' | head -2
if echo "$PRED" | flat | grep -q '"device":\s*"cpu"'; then echo "FAIL: ran on cpu"; exit 1; fi

echo
echo "=== warm predict (expect tens of ms) ==="
T2=$(date +%s%N)
WARM=$(post '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"predict","arguments":{"state":{"situation":"A team must choose one of two deployment strategies."},"questions":{"q":{"type":"choice","instructions":"Which strategy?","criteria":{"canary":"Ship behind a canary flag","bigbang":"Deploy to everyone at once"}}}}}}' "$SID")
echo "warm predict in $(( ($(date +%s%N) - T2) / 1000000 ))ms"
echo "$WARM" | flat | grep -oP '"choice":\s*"[^"]*"' | head -1

echo
echo "=== onesystem stop (must release the model) ==="
$CLI stop 2>&1 | tail -3
sleep 2
V3=$(vram); L3=$(owned_laya)
echo "VRAM $(mb "$V3")   onesystem-owned laya procs $L3"
if [ "$L3" -eq 0 ]; then echo "OK: laya process released"; else echo "FAIL: $L3 laya procs still owned"; exit 1; fi
echo "VRAM reclaimed: $(mb $((V2 - V3)))"
