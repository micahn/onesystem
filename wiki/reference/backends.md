---
id: backends
title: Backends and transports
kind: reference
surface: [cli, http]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: reference
tags: [reference, backends, transports, config]
---

# Backends and transports

A **backend** is a named entry in the config. A **transport** is how onesystem reaches it.
The two are separate questions: a model can satisfy every requirement in
[compatibility](compatibility.md) and still need a different transport to be launched.

## The three transports

| transport | onesystem does | lifetime | used by |
|---|---|---|---|
| `stdio-mcp` | starts a local MCP process over stdio, speaks MCP to it | starts on first call, stops after `idleShutdownSecs` | laya, julia |
| `systemone-serve` | starts a service, polls `GET /health` until it returns `{"status":"ready"}`, stops it on idle | same | rizzo |
| `systemone-http` | forwards to a service that is **already running** | never managed | not in the shipped config |

### `stdio-mcp`

onesystem owns the process. It starts on the first call that needs it and stops it when the
idle window expires, which is what makes the "the GPU came back" behaviour in the card
worth having. The startup budget is generous by default — 180 s — because laya's server is
silent for around 30 s importing transformers before it binds stdio.

### `systemone-serve`

The same lifecycle, for a model that ships a server rather than a library. Two differences
matter:

- **Readiness is `{"status":"ready"}`, not HTTP 200.** A service that is listening but not
  loaded answers 200 and is not ready. Polling for 200 is how you get a connection-refused
  on the first real request.
- **`cwd` is part of the contract.** rizzo resolves its weights relative to where it was
  started, so a block without `cwd` starts a service that finds nothing and reports no
  models. This is why the runtime directory for a cloned model *is* the clone: its
  virtualenv holds absolute paths and cannot be built in a staging directory and moved.

### `systemone-http`

For a service you run yourself. onesystem forwards and never touches its lifecycle, so it
is not counted as holding the GPU and is not shut down on idle. Not in the shipped config,
because a disabled entry in everyone's config is not a feature — add your own.

## A config block

```jsonc
{
  "backends": {
    "rizzo": {
      "transport": "systemone-serve",
      "command": ["/path/to/runtimes/rizzo/.venv/bin/rizzo", "serve"],
      "cwd": "/path/to/runtimes/rizzo",
      "baseUrl": "http://127.0.0.1:8017",
      "healthPath": "/health",
      "systemonePath": "/v1/systemone",
      "model": "rizzo-latest",
      "toolPrefix": "rizzo_",
      "startupTimeoutSecs": 120,
      "tools": ["predict"],
      "enabled": true
    }
  }
}
```

Three fields are load-bearing in a way that is easy to miss:

- **`tools` is required and cannot be empty.** onesystem will not start a model to ask it
  what tools it has, because `/catalog` has to answer without loading anything. A backend
  declaring no tools is refused rather than given a block that cannot work.
- **`startupTimeoutSecs` must be under `requestTimeoutSecs`.** A cold start is spent inside
  the first call, so a startup budget the request ceiling cannot reach is a config that
  rejects its own output. The default request timeout is 180 s; a stdio backend that omits
  `startupTimeoutSecs` takes 180, which is why the default had to move up from 120.
- **`toolPrefix` is what keeps two engines' `predict` apart.** All three publish a tool
  called `predict`; without prefixes the catalog lists the same name twice. The prefix is
  emitted by `onesystem install` and belongs to the model, not to your config.

## Adding a model

1. Add a `ModelSpec` to `src/models.ts`. If the model brings its own environment, use
   `clone`; if onesystem resolves it from a manifest, give it a pinned `requirement`.
2. `bun run typecheck && bun test`. There are invariants here — no two models may publish
   the same prefixed tool name, and a model that shares a bare name with a peer has to
   declare a prefix.
3. `onesystem install <model>`, then check it against the matrix in
   [compatibility](compatibility.md) and add the result.

The declared `tools` list is the one thing you cannot discover at runtime, so it has to be
right in the source. Verify it against the model's own `tools/list` before committing.

## See also

[What a model has to provide](compatibility.md) · [MCP tools](mcp-tools.md) ·
[CLI](cli.md)
