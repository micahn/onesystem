---
id: models
title: The models, and where they document themselves
kind: reference
surface: [mcp, http, cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: reference
tags: [reference, models, upstream, links]
---

# The models, and where they document themselves

This wiki documents **onesystem**: the service, the contract, and where a decision engine
fits in a workflow. It does not document the engines. Three projects change on their own
schedules, and a paraphrase of their APIs in here would be wrong within a release.

So: what follows is the minimum you need to know to choose and to port, and a link to the
authoritative source for everything else.

## laya

**<https://huggingface.co/convaiinnovations/laya>**

The widest surface of the three, and the only engine with more than `predict`: `status`,
`route`, `decide`, `shortlist`, `preset`, and two batch variants. Non-autoregressive, so
`route` can pick a workflow from a description without a language model in the loop, and
`shortlist` does high-cardinality ranking by embedding the options and keeping the top *k*.

Needs `state` as an **object**. Runs on torch, so it wants a working accelerator — it is the
heaviest of the three at 2.9 GB.

Two things worth knowing that its own docs do not lead with:

- `action.act_probability` is `1.0` on every answer and is not a confidence. See
  [Guardrails](guardrails.md).
- Its `noul` confidence is `1 − noul`, so it reports P(false) under the name confidence.

Its 34-label behaviour is worth reading if you hit a warning: 34 labels measured *better*
than a hand-picked 10 on the same input. The clamp is real; it was not the cause of the bad
result it was blamed for.

## julia

**<https://huggingface.co/SupersonicLabs/Julia-1>** (package `supersonic-julia`)

Ships a library and **no server**, so the MCP surface is a shim in the onesystem repo —
`src/shims/julia-mcp.py`. That is worth knowing before you go looking for an endpoint.

Needs `state` as a **string**. The smallest footprint of the three at 1.0 GB, and the
fastest warm at 16 ms.

The reason to be careful with it: it reports above `0.90` confidence on 26 wrong answers,
several at exactly `1.0`, and it reliably picks the cheap or delegating option — more memory
over streaming, grow the partition over pruning, wait and watch over escalating.

## rizzo

**<https://github.com/Rizzo-AI-Academy/rizzo-flow>**

Ships its own server, its own pinned llama.cpp runtime and its own weights, and is installed
by cloning rather than resolved from a manifest. It is the only one of the three that runs
on AMD over Vulkan, which is what makes it usable on this machine at all.

Needs `state` as either an object **or** a string — the only engine that does — which makes
it the portable choice when a caller does not want to branch. Reports its own internals per
call: input tokens, inference time, queue time, peak device bytes.

By a wide margin the most accurate of the three, and the only one whose confidence is usable
as a gate: 52 of 52 correct in its high-confidence band.

It also has its own benchmark suite and published results upstream, which are worth reading
if you want numbers that are not from this machine.

## When to read past this wiki

| you want | go to |
|---|---|
| the full question-type spec | each project's own docs; the shapes are in [compatibility](compatibility.md) |
| a language-specific binding | the project's docs — onesystem has no Python API, it is an HTTP and MCP service |
| ONNX, LangChain, or a hosted endpoint | laya's docs. onesystem runs models locally, as processes or as a local service |
| benchmarks not taken on this machine | rizzo's `benchmarks/`, and the [A/B/C writeup](https://micahn.github.io/onesystem-ab/) |

## See also

[What a model has to provide](compatibility.md) ·
[Choosing an engine](../patterns/choosing-an-engine.md) · [Backends](backends.md)
