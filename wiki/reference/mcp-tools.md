---
id: mcp-tools
title: The tools, and what they are called
kind: reference
surface: [mcp, http, cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: reference
tags: [reference, mcp, tools, naming]
---

# The tools, and what they are called

## One tool is portable; the rest are laya's

Every engine in the model table answers `predict`. That is the portable surface, and it is
the only tool this wiki's patterns depend on.

**laya publishes eight**: `predict`, `status`, `route`, `decide`, `shortlist`, `preset`,
`predict_batch`, `route_batch`. They are genuinely useful — `route` for picking a workflow
from a description, `preset` for a prebuilt classifier — and they are **laya's**, not
onesystem's. There is no equivalent on julia or rizzo, and no shim that would make one
honest.

A note in this wiki that uses one of them carries `engines: [laya]` in its frontmatter.
That is not a caveat, it is the scope of the note.

## The name you call depends on your config

This is the part that surprises people, and it is deliberate. The registered tool name is
not a property of the model; it is a function of how many engines you have enabled.

| enabled engines | config `routing.resolve` | julia's tool is called |
|---|---|---|
| julia only | — | `predict` |
| julia + laya + rizzo | unset | `julia_predict` |
| julia + laya + rizzo | `julia` | `predict` |

laya and rizzo are unaffected in practice, because they both declare a `toolPrefix`, so
their tools are `laya_predict` and `rizzo_predict` whether or not anything else is enabled.

**A client should not hardcode these names.** Ask the catalog, or use the HTTP front door,
which takes a `backend` and a `tool` separately and is stable regardless of how many
engines are enabled:

```bash
curl -s localhost:7331/catalog | jq '.backends[] | {backend, tools: [.tools.tools[].name]}'
```

With nothing declared, **every** enabled engine is qualified. That is not an oversight: a
declared default is a claim somebody made, and with no claim there is nothing to justify
one engine being the unqualified one. Changing it would rename every tool in every live
session on a multi-engine setup.

## The MCP endpoints

onesystem serves MCP per backend. The path is the backend name, and the tools are whatever
that backend declares:

```
POST /mcp/<backend>      JSON-RPC 2.0. The session id comes back on initialize.
```

```bash
# 1. initialize, and keep the session id
SID=$(curl -si -X POST localhost:7331/mcp/rizzo \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"you","version":"1"}}}' \
  | grep -i '^mcp-session-id' | tr -d '\r' | cut -d' ' -f2)

# 2. acknowledge, then call
curl -s -X POST localhost:7331/mcp/rizzo \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

curl -s -X POST localhost:7331/mcp/rizzo \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"predict","arguments":{
        "state":{"situation":"A payments endpoint began returning 503 for 4% of requests after the connection pool was capped at 5."},
        "questions":{"cause":{"type":"choice","instructions":"What is the proximate cause?",
          "criteria":{"pool":"The pool is saturated at its cap.",
                      "upstream":"The upstream provider is degraded."}}}}}}'
```

The response body is an SSE frame: a `data: ` line holding a JSON-RPC object whose
`result.content[0].text` is **itself a JSON string** holding the answer. Two layers, and
getting it wrong at either layer produces a null that reads like a model failure.

```json
{"result":{"content":[{"type":"text","text":"{\"answers\":{\"cause\":{...}}}"}]}}
```

**Check `isError` before parsing.** A shape mismatch comes back as HTTP 200 with
`isError: true` and a plain-text validation message, not as a JSON-RPC error. See
[compatibility](compatibility.md#a-refusal-is-not-a-json-rpc-error).

## The HTTP front door

Simpler than MCP when you are writing a script, and it does not care how many engines are
enabled.

```
GET  /catalog    declared tools per backend. Loads nothing.
GET  /health     state, call counts, timings, and GPU memory per model.
POST /call       {"backend":"rizzo","tool":"predict","arguments":{…}}
```

`POST /call` is the one that matters. It takes the backend and the tool separately, so it
never suffers the naming ambiguity above, and it returns the answer as plain JSON rather
than two layers of envelope.

```bash
curl -s -X POST localhost:7331/call -H 'content-type: application/json' -d '{
  "backend":"rizzo","tool":"predict","arguments":{
    "state":{"situation":"A payments endpoint began returning 503 for 4% of requests after the pool cap was lowered to 5."},
    "questions":{"cause":{"type":"choice","instructions":"What is the proximate cause?",
      "criteria":{"pool":"The pool is saturated at its cap.",
                  "upstream":"The upstream provider is degraded."}}}}}' \
  | jq -r '.result.content[0].text' | jq '.answers.cause'
```

`GET /health` also carries a `gpu` block — total card memory, and what each loaded model
holds, attributed by the DRM accounting in `/proc/<pid>/fdinfo` rather than by a vendor
tool's process table. That distinction matters: `rocm-smi --showpids` lists compute
processes only, so a model on Vulkan reads as holding nothing.

## See also

[What a model has to provide](compatibility.md) · [Answer payload](answer-payload.md) ·
[CLI](cli.md) · [Backends](backends.md)
