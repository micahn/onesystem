#!/usr/bin/env bash
# Verify the tool surface reads `onesystem.<tool>`, not `onesystem.laya_<tool>`.
#
# Checks both directions of the rename, because a rename applied to only the catalog
# produces a server that advertises `predict` and then fails every call to it.
set -uo pipefail
cd "$(dirname "$0")/.."
URL="http://127.0.0.1:7331/mcp/laya"
HEADER="$(mktemp)"
trap 'rm -f "$HEADER"' EXIT

INIT=$(curl -s -D "$HEADER" -o /dev/null -X POST "$URL" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}')
SID=$(grep -oiP 'mcp-session-id: \K[0-9a-f-]+' "$HEADER" | head -1)
echo "session: ${SID:-<none>}"

post() {
  curl -s -X POST "$URL" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SID" -d "$1" | sed 's/\\//g'
}
post '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

TOOLS=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
echo "catalog: $(echo "$TOOLS" | grep -oP '"name":\s*"\K[a-z_]+' | sort -u | tr '\n' ' ')"

if echo "$TOOLS" | grep -q '"name":"predict"'; then
  echo "OK: catalog exposes 'predict' (prefix stripped)"
else
  echo "FAIL: 'predict' not in catalog. Body:"; echo "$TOOLS" | head -c 500; echo; exit 1
fi
if echo "$TOOLS" | grep -q '"name":"laya_'; then
  # Match the name field only. Descriptions and schema titles legitimately still say
  # `laya_predict_toolArguments`, and grepping the whole body trips over those.
  echo "FAIL: catalog still exposes prefixed tool names"; exit 1
fi
echo "OK: no prefixed names in the catalog"

echo
echo "calling the short name..."
CALL=$(post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"predict","arguments":{"state":{"situation":"A team must pick one of two release strategies for a flaky service."},"questions":{"q":{"type":"choice","instructions":"Which release strategy?","criteria":{"canary":"Ship behind a canary flag to a small slice first","bigbang":"Deploy to every host at once"}}}}}}')
if echo "$CALL" | grep -q 'unknown tool'; then
  echo "FAIL: backend does not recognise the short name (rename not restored inbound)"
  echo "$CALL" | head -c 500; echo; exit 1
fi
if echo "$CALL" | grep -q '"choice"'; then
  echo "OK: short name reached the backend and answered"
  echo "  device: $(echo "$CALL" | grep -oP '"device":\s*"\K[^"]+' | head -1)"
  echo "  choice: $(echo "$CALL" | grep -oP '"choice":\s*"\K[^"]+' | head -1)"
else
  echo "FAIL: no answer. Body:"; echo "$CALL" | head -c 500; echo; exit 1
fi
