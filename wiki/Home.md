---
id: home
title: Onesystem Wiki
kind: meta
surface: [mcp, http, cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: current
tags: [moc, onesystem, decision-engines]
---

# Onesystem Wiki

onesystem runs local **decision engines** behind one service and one payload. An engine
answers **typed questions** over any state in a single pass, and it does not generate text.
That single design choice is the reason this wiki exists: the interesting problems in an
agent workflow are not "write the answer" problems, they are "which of these five things is
true" problems. Those are exactly what a calibrated classifier is good at, and exactly what
a language model is mediocre at while costing orders of magnitude more.

The catch is that a classifier is only as useful as the questions you know to ask it. So
this wiki is organised around **decision points in real workflows**, not around an API.

## Read this first: they are not interchangeable

Three engines are installed. They answer the same three question types over the same
`{state, questions}` payload, and they are **not** drop-in replacements for each other:

- **`state` is typed differently.** laya requires an object, julia requires a string, and a
  payload written for one is a validation error in the other at the type checker. rizzo is
  the only one that takes either.
- **Confidence means different things, and on two of the three it means nothing usable.**
  Measured over 100 cases: rizzo's high-confidence band was 52 of 52 correct; laya's was
  56% against a 46% base rate; julia's was 54% against 50%, and it reported above `0.90`
  confidence on 26 wrong answers.
- **The tool name you call depends on your config**, because it is derived from how many
  engines are enabled.

If you only read one page, read
[What a model has to provide](reference/compatibility.md). It is the contract, it is
measured rather than asserted, and it is what makes porting possible instead of a rewrite.

## Start here

- **What can a model do at all?** → [What a model has to provide](reference/compatibility.md)
  — the measured matrix, and the seven requirements
- **Which one should I use?** → [Choosing an engine](patterns/choosing-an-engine.md)
- **What comes back?** → [Answer payload](reference/answer-payload.md), field by field
- **How do I call it?** → [MCP tools](reference/mcp-tools.md) · [CLI](reference/cli.md) ·
  [Backends](reference/backends.md)
- **When should I *not* use it?** → [Guardrails](reference/guardrails.md) — read this one
  before wiring any of this into something that matters
- **Where does it fit in my work?** → [34 use cases](use-cases/index.md) ·
  [skill integration](patterns/wiring-into-skills.md)

## The one-paragraph version

An engine takes a `state` and a set of `questions`, each typed as `choice` (pick a label
from a set you define), `score` (place it on an ordinal rubric you define), or `noul` (a
calibrated probability of one proposition). It returns probabilities, not text. Because the
labels and rubrics are *yours*, you can encode your own vocabulary — your triage states,
your Fowler smells, your bug hypotheses — instead of convincing a general model to use it.
One pass answers every question at once, so asking five related questions costs about the
same as asking one.

## The four things people get wrong

1. **Reading `act_probability` as confidence.** It is `1.0` on every answer laya has ever
   returned. It is not a confidence. See
   [the trap](reference/guardrails.md#1-read-the-act_probability-trap-first-because-it-will-mislead-you).
2. **Assuming confidence is a gate.** It is, on rizzo, and it is not on laya or julia. The
   doctrine is per-engine now, and [the measurements](reference/guardrails.md#2-confidence-is-per-engine-and-two-of-the-three-have-none-worth-using)
   are what changed it.
3. **Padding the `state`.** A verbose restatement of a situation performed far worse than a
   short focused one — `0.3059` against `0.9644` — at every option count, and it was
   confidently wrong. Write the shortest accurate description.
4. **Asking it open questions.** It will not summarise your diff or reason across five
   files. It will hand you a confident label for a question you did not know how to pose.
   Every use case here is a *typed* question for a reason.

## Do not average the engines

Measured, on the same cases: rizzo alone **86.4%**, a three-model majority **65.9%**, and
the ceiling for any router at all **93.2%** — three cases above the best single engine. A
majority vote only helps when the engines are of comparable quality, and these are not. If
you want redundancy, make it conditional: one engine answers and only its low-confidence
tail escalates. See [Choosing an engine](patterns/choosing-an-engine.md#do-not-ensemble-them).

## The wiki is also an index

`index/usecases.json` is the machine-readable half, and it is searched by whichever engine
is active. Its `criteria` block is shaped to be drop-in valid as a `choice` question's
criteria, so an engine can rank this wiki's own use cases against a live situation with no
adapter. [The contract](index/schema.md) explains the fields;
[self-search](patterns/self-search.md) shows the call. **Prose may elaborate, never
contradict** — the rule that keeps the two halves honest.

## What the measurements changed

Every latency and probability here was measured on this machine, and several results
overturned an earlier draft of these notes. They are kept in, because a wiki that only
records its successes is not worth maintaining.

- **Confidence is a gate — on one engine.** The older version of this page said it was not a
  gate at all, on the strength of laya alone. It is a gate on rizzo and is not on the other
  two, which is a more useful sentence than the one it replaced.
- **`state` quality is the biggest lever, and padding it usually hurts.** Focused beat
  verbose 2 times out of 3, by ~0.65 both times. The third is the interesting one: verbose
  scored *higher* and was still wrong, so the failure mode is a confident error rather than
  a hedged one.
- **34 labels is fine.** A documented `choice:11+` temperature clamp was blamed for a bad
  result; isolating the variable showed 34 labels beat a hand-picked 10 on the same input.
- **Following the official shortlist advice made things worse** — 2224 ms instead of
  30.7 ms, with the correct answer dropped.

Details: [Choosing an engine](patterns/choosing-an-engine.md),
[Guardrails](reference/guardrails.md), and the
[full A/B/C writeup](https://micahn.github.io/onesystem-ab/).

## Verified on this machine

onesystem with laya 0.3.21, julia 0.1.0 and rizzo-flow 4b q8 · AMD RX 9070 XT (gfx1201) ·
rizzo on Vulkan/RADV, laya and julia on torch. Latencies and probabilities quoted throughout
are measured. See [the models](reference/models.md) for what each one documents itself.
