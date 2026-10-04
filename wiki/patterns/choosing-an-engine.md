---
id: choosing-an-engine
title: If you add a second engine
kind: pattern
surface: [cli, http, mcp]
tools: [predict]
engines: [rizzo]
question_types: [choice, score, noul]
status: reference
tags: [pattern, selection, calibration, latency]
measured_at: "2026-09-29, 100 cases across three corpora, RX 9070 XT"
---

# If you add a second engine

onesystem fronts three engines that answer the same three question types over the same
`{state, questions}` payload. They are not interchangeable, and the differences that matter
are not the ones a feature list would lead you to expect.

**This page matters only if you are choosing.** If one engine is already installed and
answering, [what a model has to provide](../reference/compatibility.md) is the page to read --
it says whether what you have qualifies, and what it cannot do.

The measurements are in [the comparison writeup](https://micahn.github.io/onesystem-ab/);
the requirements any engine has to meet are in
[what a model has to provide](../reference/compatibility.md).

## What kind of engine you are choosing between

All three are **classifiers over text**, not generators. None of them writes a summary,
reasons across files, or does arithmetic. The question they answer is always "which of
these things is true" or "where on this scale", and the labels and rubrics are yours. That
is the whole design, and it is why they are cheap and fast next to a language model and
why they are useless outside that shape.

The differences between them are therefore not about capability. They are about three
things:

1. **Whether you can tell when it is unsure** — which decides whether it can run unattended.
2. **How wrong it is when it is wrong** — random errors get caught by a second look,
   systematic ones do not.
3. **What it costs** — latency, memory, and whether two of them fit on the card at once.

## The three, measured

100 cases across three corpora: 20 and 44 software-engineering decisions, 36 across
support triage, bug diagnosis, Linux desktop problems and judgement calls. Every case asked
all three engines the identical question.

| | laya | julia | rizzo |
|---|---|---|---|
| accuracy, pooled | 46/100 | 50/100 | **85/100** |
| per-corpus range | 40–50% | 39–60% | **83–86%** |
| high-confidence band | 56% correct | 54% correct | **100% — 52/52** |
| base rate, for comparison | 46% | 50% | 85% |
| wrong answers above `0.90` confidence | 0 | **26** | 0 |
| warm median | 23 ms | **16 ms** | 195 ms |
| cold start | 8.3 s | 11.9 s | **7.4 s** |
| VRAM resident | 2.9 GB | **1.0 GB** | 5.9 GB |
| deterministic on repeat | yes | yes | yes |

Read the two range rows before anything else. laya and julia swing 10 and 21 points
depending on the domain, so a blended number for either is describing an average of two
different models. rizzo's accuracy barely moves.

## The decision

**Default to rizzo** when you have the choice. It is the only one whose confidence is usable, and that is the whole
argument. Its high-confidence band was 52 of 52 correct, it reports confidence as low as
0.05 so there is a real tail to escalate, and its accuracy is stable across domains. That
pair of facts is what makes a two-tier design worth building rather than merely tidy.

**Use laya when latency or memory is the binding constraint and a human is reading the
result anyway.** It is 8× faster warm than rizzo and uses half the memory, and at 46% it is
not going to be right on its own. Its one genuine strength over julia is outside software
engineering: 8/10 on support tickets against julia's 4, and 4/10 on desktop against julia's
3.

**Use julia only for software engineering, and only if you have already checked the
answer.** It is the fastest and the smallest, and it is the best of the two non-rizzo
engines on engineering specifically — 23/38 against laya's 15/38. It is also the one to be
most careful with, for the reason below.

## Why calibration beats accuracy in this decision

A model that is right 46% of the time and knows it is unsure is more useful than one that
is right 85% of the time and has no idea. The second still needs checking on every answer;
the first only needs checking on the answers it flags.

That is why the high-band row matters more than the accuracy row, and why julia's 50/100 is
worse than it looks:

- **rizzo** — 52/52 in the high band. Act on those unattended.
- **laya** — 18 answers in the band, right 56% of the time against a 46% base rate. Real
  signal, useless in practice: skipping the check on a band that is right 56% of the time
  automates the error rather than avoiding it.
- **julia** — 78 answers in the band, right 54% against 50%, and it reported above `0.90`
  confidence on **26 wrong answers**, several at exactly `1.0`. An uncertain wrong answer
  is the useful kind, because it is the one you would have checked. julia removes that.

## How they fail, which is the part that is not in a feature list

**laya and julia are not independent.** On 9 of 44 engineering cases they agreed with *each
other* against ground truth while rizzo was right — `proceed_anyway`, `env_file`,
`drop_one`, `implicit`, "the backup is fine". Both also under-assert on `noul`: six of
laya's seven `noul` errors were "said false when the answer was true", and five of julia's
six. Two models agreeing is not two pieces of evidence when they share a bias, and a
directional bias is the kind a second glance does not catch.

**julia picks the cheap or delegating option.** More memory over streaming the input. Grow
the partition over pruning and rebalancing. Wait and watch over escalating. Forward the
phishing email to a colleague over verifying it out of band. Each is a defensible-sounding
answer that declines to do the work, and the pattern holds across unrelated domains.

**rizzo is the only one never solely responsible for a miss.** On the 44-case engineering
corpus there was no case where rizzo was wrong and both others were right.

## Do not ensemble them

Measured, on the same cases:

| strategy | accuracy |
|---|---|
| rizzo alone | **86.4%** |
| three-model majority | 65.9% |
| any engine correct (the ceiling for any router) | 93.2% — 3 cases above rizzo alone |

A majority vote only helps when the engines are of comparable quality. When one is clearly
better than the other two, the modal answer is usually wrong, because two weak engines
outvote the strong one on exactly the cases the strong one finds difficult. And the ceiling
is 3 cases: **perfect routing between these three would gain three cases out of 44**, so
there is almost nothing to win, and the realistic strategy loses 20 points.

If you want a second opinion, make it conditional and one-directional: rizzo answers, and
only its low-confidence tail goes to a human or a slower model.

## The wiring, if you are switching

The requirements that make switching possible are in
[compatibility](../reference/compatibility.md). The two that bite:

- **rizzo is the only engine that takes `state` as either an object or a string.** laya
  needs an object, julia needs a string. A payload written for laya is a validation error
  in julia, and vice versa.
- **The tool name you call is context-dependent.** With one engine enabled it is bare
  (`predict`); with several and no default configured they are all qualified
  (`laya_predict`, `julia_predict`, `rizzo_predict`); with a default configured, that
  engine keeps the bare name. See [MCP tools](../reference/mcp-tools.md).

## See also

[What a model has to provide](../reference/compatibility.md) ·
[Guardrails](../reference/guardrails.md) · [Multi-question batches](multi-question-batches.md) ·
[the full A/B/C writeup](https://micahn.github.io/onesystem-ab/)
