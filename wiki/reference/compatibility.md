---
id: compatibility
title: What a model has to provide to be usable
kind: reference
surface: [mcp, http, cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: reference
tags: [reference, compatibility, requirements, portability]
measured_at: "2026-09-29, onesystem 0.3.x, laya 0.3.21, julia 0.1.0, rizzo-flow 4b q8"
---

# What a model has to provide to be usable

The portable surface of a decision engine, as it actually is rather than as it is
advertised. Everything here was measured against the three installed engines, not read off
a README, because the requirements and the conveniences are not the same list.

**The portable surface is one tool and three question types.** Every other tool any of
these engines exposes is a bonus you cannot rely on. If a workflow in this wiki depends on
something outside that surface, its frontmatter says `engines: [laya]` and it means it.

## The state shape is a hard requirement, and each engine draws it differently

This is the first thing that breaks a port, and it breaks at the type checker rather than
at the answer, which is the good case: it fails immediately and says why.

`state` is either an **object** or a **string**, and the three engines do not agree:

| engine | `state` as an object | `state` as a string |
|---|---|---|
| **laya** | accepted | **refused** — `Input should be a valid dictionary` |
| **julia** | **refused** — `Input should be a valid string` | accepted |
| **rizzo** | accepted | accepted |

Measured across all three question types with the same situation text; see
`scripts/compat.ts` in the comparison harness that produced the matrix, and regenerate it
with `bun run src/compat.ts`.

**rizzo is the only engine that takes either**, so a caller that wants to be portable
without branching should prefer it, or normalise the state itself before dispatch.

### A refusal is not a JSON-RPC error

A shape mismatch comes back as HTTP 200 with `isError: true` and a plain-text validation
message:

```
Error executing tool laya_predict: 1 validation error for laya_predict_toolArguments
state
  Input should be a valid dictionary [type=dict_type, input_value='a bare string', input_type=str]
```

It is *not* a JSON-RPC `error`, and `content[0].text` is **not** JSON — it is the message.
A reader that assumes the text always parses reports
`SyntaxError: JSON Parse error: Unexpected identifier "Error"`, which reads like a broken
install and is actually a misread contract. Check `isError` before parsing. The message
itself is good: it names the field and the type it wanted.

## The three question types, and the criteria shape each one demands

All three engines answer all three types. The `criteria` block is not the same shape for
each, and getting it wrong is the second most common way to break a port.

| type | `criteria` is | answers with | means |
|---|---|---|---|
| `choice` | `{label: description, …}` | a `choice` plus `probabilities` per label | which of these is true |
| `noul` | exactly `{"false": …, "true": …}` | a `noul` probability | how likely a single proposition is |
| `score` | an **ordered array** of rubric strings, lowest first | a `score` plus a `legend` | where on a scale you defined |

`score` takes an array, not an object. Passing `{"low": "…", "high": "…"}` is rejected with
`questions[d].criteria must be a non-empty list of rubric levels`, and passing two levels
where the rubric wants three is accepted but means something different from what you
wrote.

A `noul` question with no `criteria` at all is also accepted, and the model supplies its
own framing of the two outcomes. That is convenient and it moves the definition out of your
hands — see [Guardrails](guardrails.md).

## Where the answers diverge, which is the part that bites

The inputs can be made identical. The outputs cannot, and a caller that reads all three
with one parser will silently mis-score two of them.

### `noul` has no declared polarity

`noul` is a bare probability with nothing saying which way it points, on laya and rizzo
alike. It is read here as **P(true)**, and that reading is supported: julia returns an
explicit `probabilities: {false, true}` map alongside its `noul`, and the two agree exactly
— ask "is the disk destroyed?" and julia reports `noul: 0.006641` with
`probabilities.true: 0.006641`; ask "is the disk fine?" and it reports
`noul: 0.000105` with `probabilities.true: 0.000105`. laya and rizzo share the field and
the contract, so `noul` is P(true) for them too.

**If that inference is wrong, every `noul` score from laya and rizzo inverts.** It is an
assumption, not a guarantee, and it is the single thing in this page most worth re-checking
against a model upgrade.

On laya specifically, `confidence` on a `noul` answer is `1 − noul`, so it reports P(false)
labelled as confidence. Reading it as a confidence inverts the signal. This page drops it
and uses `noul` itself.

### `score` is soft on laya, near-integer elsewhere

laya returns a continuous position — `1.2826` for a question whose argmax is level `1` —
while julia and rizzo return something very close to an index (`1.99997`, `1.0112`).
Score them the same way: take the argmax of the `probabilities` map, not the position.
laya and rizzo both supply `legend`, mapping index to the level text you wrote.

### Confidence is named three ways, and laya returns two of them at once

| engine | field on a `choice` answer | on `score` | on `noul` |
|---|---|---|---|
| laya | `confidence`, `answer_confidence` | **both**, and they differ | `confidence` (= 1 − `noul`) |
| julia | `max_probability` | `max_probability` | none |
| rizzo | `confidence` | `confidence` | none |

laya's `score` answer carrying `confidence: 0.2798` *and* `answer_confidence: 0.6312` in the
same object is the sharpest version of the problem: two numbers, both called confidence,
nearly three times apart.

**And one field is a lie told by the schema.** laya's `action.act_probability` is `1.0` on
every answer ever returned and carries no information. Never average it in; a column of
`1.0`s reads as perfect confidence. See [Guardrails](guardrails.md).

## What a model has to provide, as a checklist

Each item is a requirement, with where it is checked.

1. **A `predict` tool taking `{state, questions}`.** onesystem forwards to a tool with that
   name. A model whose entry point is called something else needs a shim — julia's is in
   this repo, in `src/shims/`, for exactly this reason.
2. **One `state` shape, accepted consistently.** Not "usually": laya and julia each accept
   exactly one and refuse the other with a validation error.
3. **The three question types, with the `criteria` shape each one specifies.** Object for
   `choice` and `noul`, ordered array for `score`.
4. **A probability per option.** Without one there is no argmax, so there is no answer —
   the engine has to rank, not just choose.
5. **A confidence, or an honest absence of one.** This is the requirement that decides
   whether the engine is usable *unattended*, and the three installed engines answer it very
   differently: rizzo's high-confidence band was 52/52 correct across 100 cases, laya's
   56% against a 46% base rate, julia's 54% against 50% with 26 wrong answers reported above
   `0.90`. Two of the three cannot be gated on. See [Choosing an engine](../patterns/choosing-an-engine.md).
6. **Stability.** A threshold is only meaningful if the same input gives the same answer.
   All three measured engines were fully deterministic across repeated runs — 100/100
   identical answers — which is what makes any of this measurable at all.
7. **A declared tool surface.** onesystem will not start a model to ask it what tools it
   has, because `/catalog` has to answer without loading anything. `tools` is declared in
   config, and a backend that declares an empty list is refused rather than given a block
   that cannot work.

### Transport is a separate question from capability

A model can satisfy all seven and still need a different way to be launched:

| transport | onesystem does | used by |
|---|---|---|
| `stdio-mcp` | starts and stops a local MCP process | laya, julia |
| `systemone-serve` | starts a service, polls `GET /health` for `{"status":"ready"}`, stops it on idle | rizzo |
| `systemone-http` | forwards to a service that is already running | not in the shipped config |

The transports differ in lifecycle, not in what a question looks like. See
[Backends](backends.md).

## Where each engine documents itself

This page is the contract. The specifics belong to their authors, and are better there
than paraphrased here:

- **laya** — <https://huggingface.co/convaiinnovations/laya> — 8 tools, the widest surface
  of the three, and the only engine with a language router.
- **julia** — <https://huggingface.co/SupersonicLabs/Julia-1> — ships a library and no
  server, so the MCP surface in this repo is a shim over it.
- **rizzo** — <https://github.com/Rizzo-AI-Academy/rizzo-flow> — ships its own server, its
  own pinned llama.cpp runtime and its own weights; runs on AMD over Vulkan.

## See also

[Answer payload](answer-payload.md) · [MCP tools](mcp-tools.md) ·
[Choosing an engine](../patterns/choosing-an-engine.md) ·
[Guardrails](guardrails.md)
