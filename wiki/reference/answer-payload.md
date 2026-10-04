---
id: answer-payload
title: Answer payload, and where the engines disagree about it
kind: reference
surface: [mcp, http]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: reference
tags: [reference, payload, probabilities, confidence]
---

# Answer payload, and where the engines disagree about it

## The shape they share

Every answer is a `type`-discriminated object under `answers.<your question id>`, and every
one of them carries probabilities. None of them carries text the model wrote — that is the
point.

```jsonc
{
  "answers": {
    "<your id>": {
      // choice
      "type": "choice",
      "choice": "pool",                       // the argmax label
      "probabilities": { "pool": 0.966, "upstream": 0.034 },

      // noul
      "type": "noul",
      "noul": 0.113,                          // P(true). No polarity is declared — see below.

      // score
      "type": "score",
      "score": 1.011,                          // a position, not necessarily an index
      "legend": { "0": "Cosmetic.", "1": "Annoying.", "2": "Blocks work." },
      "probabilities": { "0": 0.44, "1": 0.12, "2": 0.45 },

      // and, on laya only, two fields that mean different things
      "confidence": 0.171,
      "answer_confidence": 0.631,
      "action": { "act_probability": 1 }
    }
  }
}
```

Score a `score` by the argmax of `probabilities`, not by `score`. laya's `score` is a
continuous position — `1.2826` for a question whose argmax is level `1` — so rounding it
gives a different answer than the distribution does about half the time.

## Read `probabilities`, not just the winner

The winner is one argmax over a distribution that is often nearly flat. Two cases that
return the same label are not the same case:

- `{"pool": 0.51, "upstream": 0.49}` — genuinely undetermined, and worth a human.
- `{"pool": 0.97, "upstream": 0.03}` — determined, and worth acting on.

If the top two are within about 0.1, the question was ambiguous rather than the model being
unsure. Those want a better `state`, not a retry.

## The four divergences, and what to do about each

### 0. rizzo disclaims its own numbers, and you should believe it

Every rizzo response carries this, on every question type, without exception:

```jsonc
"x_rizzo": { "probability_status": ["uncalibrated_conditional_option_scores"] }
```

Read it as the model's own statement: these are **conditional option scores, not
calibrated probabilities**. `0.98` does not mean "98% likely to be right".

This is worth stating first because the natural reading of a field called `confidence` is
the opposite, and because "calibrated classifier" is the phrase every description of this
kind of engine reaches for. An earlier draft of this wiki asserted it before anyone had read
that field.

laya and julia do not publish an equivalent disclaimer, which is not the same as being
calibrated — see [Guardrails](guardrails.md) for what was measured, which is a separate
question from what a model claims about itself.

One more field to distrust on rizzo: `timing.peak_device_bytes` reads `0` on most calls and a
real figure on some. It is not a reliable per-call measurement; `GET /health` is the place
for VRAM.

### 1. `noul` does not declare its polarity

`noul` is a bare probability and nothing says which way it points. This page reads it as
**P(true)**, and that is supported rather than assumed: julia returns an explicit
`probabilities: {false, true}` map next to its `noul` and the two agree exactly, in both
directions of the same question. laya and rizzo share the field and the contract.

**This is the load-bearing assumption in the whole page.** If it is wrong, every `noul`
score from laya and rizzo inverts. Re-check it against a model upgrade.

On laya, `confidence` on a `noul` answer is `1 − noul` — it reports P(false) under the name
confidence. Using it as a confidence inverts the signal. Use `noul` itself.

### 2. Confidence is named three ways, and laya returns two at once

| engine | `choice` | `score` | `noul` |
|---|---|---|---|
| laya | `confidence`, `answer_confidence` | **both, and they differ** | `confidence` (= 1 − `noul`) |
| julia | `max_probability` | `max_probability` | none |
| rizzo | `confidence` | `confidence` | none |

laya's `score` answer carrying `confidence: 0.2798` and `answer_confidence: 0.6312` in one
object is the sharpest form of the problem. Pick one field per engine and write down which.

A reader that tries them in order — `max_probability`, then `answer_confidence`, then
`confidence` — silently picks differently for different engines, which is the kind of bug
that shows up as a model difference when it is a parser difference.

### 3. `act_probability` is a schema placeholder

`action.act_probability` is `1.0` on **every answer laya has ever returned**, on every
question type, including the ones it gets wrong. It is not a confidence and it carries no
information. Any code that averages confidences must exclude it: a column of `1.0`s reads
as perfect confidence and would make every other model look badly calibrated by comparison.

### 4. `probabilities` is absent on `noul` from laya and rizzo

julia gives you the full map on every type. laya and rizzo give you only the scalar for
`noul`, so there is no way to see *how far* from the boundary an answer sits beyond the
scalar itself, and no second opinion to cross-check against.

## Measured behaviour on this machine

100 cases, three corpora, all three engines, every case asked twice.

| | laya | julia | rizzo |
|---|---|---|---|
| correct | 46/100 | 50/100 | **85/100** |
| mean confidence when right | 0.595 | 0.855 | 0.730 |
| mean confidence when wrong | 0.582 | 0.787 | 0.326 |
| gap | +0.012 | +0.068 | **+0.404** |
| precision in the high band (≥ 0.70) | 56% | 54% | **100% (52/52)** |
| lowest confidence ever reported | 0.31 | 0.00 | 0.05 |

The gap row is the one to act on. A model whose confidence does not separate right from
wrong cannot be gated on, and two of the three cannot.

`julia` reporting a low of `0.00` while its high band is 54% correct is worth stating
plainly: it *can* express doubt, and doing so does not help, because the rest of the range
is saturated near 0.85 and carries 26 wrong answers above `0.90`.

## See also

[What a model has to provide](compatibility.md) · [Guardrails](guardrails.md) ·
[Choosing an engine](../patterns/choosing-an-engine.md)
