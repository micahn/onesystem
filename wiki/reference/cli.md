---
id: cli
title: The onesystem command
kind: reference
surface: [cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: reference
tags: [reference, cli, install, doctor]
---

# The onesystem command

onesystem installs models, starts the local service, and keeps the config honest. It does
not have a `predict` subcommand: the models are reached over MCP or HTTP, and the CLI is
about the service around them.

## The commands

```
onesystem install <model>    fetch and install a model, then write its config block
onesystem use <model>        enable one model and disable the others
onesystem start              start the daemon
onesystem stop               stop it
onesystem status             config, registrations, and the health report as JSON
onesystem runtimes           which models are installed, and where
onesystem doctor [--fix]     check the config and the installed runtimes
onesystem use --help         and the rest
```

## install

```bash
onesystem install rizzo
```

Clones the model, builds its environment, fetches what it needs, writes its config block,
and enables it. Around five minutes for rizzo, most of it a 4.4 GB weight download; the two
resolved models are quicker.

A model that brings its own environment is installed differently from one onesystem
resolves from a manifest, and the difference is visible in the output. rizzo has no torch in
it and does not need one, so there is no accelerator check to run; the model is asked what
it can use instead. See the `clone` field in `src/models.ts`.

**Install disables the others.** It writes an exclusive switch, so after installing a second
model the first is off. Turn it back with `onesystem use <model>`, or enable each in the
config by hand. This is deliberate — a config where three models are enabled and nobody can
say which is answering is worse than one that is obvious.

## doctor

The path for fixing an existing config. It validates the config, reports what is wrong, and
with `--fix` repairs the problems that can be repaired mechanically. A config that will not
parse is refused at install time rather than after a 4 GB download, so a broken config
fails before it costs anything.

```bash
onesystem doctor rizzo
```

For a model that brings its own environment, doctor runs the model's own diagnostic and
reports what it chose — `auto_selects: Vulkan0` on this machine — which is the actual answer
to "will this work here".

## status

JSON, and it is the contract the plugin reads rather than guessing:

```bash
onesystem status | jq '{url, running, registrations: [.registrations[] | {backend, serverName, toolPrefix}]}'
```

`registrations` is what tells a client which server names and tool prefixes to expect. The
naming rule that turns it into actual tool names is in [MCP tools](mcp-tools.md).

## runtimes

```bash
onesystem runtimes
```

Which models are installed, where their runtimes live, and which interpreter they run
under. A directory without a `meta.json` reads as a half-install rather than as installed,
which is the honest answer for an install that was interrupted.

## See also

[Backends](backends.md) · [MCP tools](mcp-tools.md) ·
[What a model has to provide](compatibility.md)
