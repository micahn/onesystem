---
id: guardrails
title: Guardrails
kind: reference
surface: [mcp, http, cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: reference
tags: [reference, guardrails, confidence, calibration]
measured_at: "2026-09-29, 100 cases across three corpora"
---

# Guardrails

Read this before wiring any of these engines into something that matters. It is ordered by
how expensive the mistake is, not by how interesting it is.

## 1. Read the act_probability trap first, because it will mislead you

laya's `action.act_probability` is `1.0` on every answer it has ever returned, on every
question type, including answers it gets wrong. It is a schema placeholder, not a
confidence.

Any code that collects confidences must exclude it. Averaged in, it contributes a column of
`1.0`s that reads as perfect confidence and makes every other engine look broken by
comparison. The one time this bit me, the symptom was not "laya looks overconfident" but
"julia looks uncalibrated" — the error landed one model over.

## 2. Confidence is per-engine, and two of the three have none worth using

This is the correction to the older version of this page, which said flatly that confidence
is not a gate. That was measured against laya alone and does not generalise.

| engine | high-band precision | base rate | usable as a gate? |
|---|---|---|---|
| **rizzo** | **100% — 52/52** | 85% | **yes: act on ≥0.70, escalate the rest** |
| laya | 56% (18 answers) | 46% | no — real signal, nothing to act on |
| julia | 54% (78 answers) | 50% | no — and 26 wrong answers reported above 0.90 |

"Real signal, nothing to act on" is worth being precise about, because it is the trap. laya's
high band is better than its base rate, so a threshold *appears* to work. But skipping the
check on a band that is right 56% of the time automates the error rather than avoiding it.
A gate has to be trustworthy in absolute terms, not merely better than nothing.

**So the doctrine is now per-engine:** rizzo's confidence is a routing signal, and laya's
and julia's are not. Do not carry a threshold across engines — it means something different
on each, and on two of them it means nothing.

## 3. A confident wrong answer is worse than an uncertain one

julia reports above `0.90` confidence on **26 wrong answers**, several at exactly `1.0`.
rizzo and laya have **zero** wrong answers above `0.90`.

This is why the uncertainty is the valuable part of the output. An uncertain wrong answer is
one you would have checked. A confident wrong answer removes the reason to check, and
removes it most reliably exactly where the model is weakest.

The older version of this page put it as "confidence says the model is sure, not that it is
right". Still true, and the measured version is stronger: for two of the three engines, the
confidence is not even a reliable statement of the former.

## 4. Pad the `state` at your peril — more text is not more information

Measured on the same situation described two ways: a short focused `state` scored `0.9644`,
a verbose restatement of the same situation scored `0.3059`, at every option count. The
verbose one was not hedged — it was confidently wrong.

Write the shortest accurate description. A `state` that omits the fact you want judged will
produce the right answer for the wrong reason, which is the failure you cannot detect by
looking at the answer.

## 5. These are classifiers, and the question has to be typed

None of the three generates text. None of them will summarise your diff, reason across five
files, or do arithmetic. Asked an open question, they hand you a confident label for a
question you did not know how to pose.

Every use case in this wiki is a *typed* question — `choice`, `score`, `noul` — for that
reason. If you cannot express the thing you want to know as one of those three, this is the
wrong tool.

And note what a classifier is good at: `diag-oom-linear-input` asks whether the cause is
memory or streaming, with a state that says memory grows linearly with row count and the
host is already at its provider ceiling. Both laya and julia answered "add memory". A model
that pattern-matches "out of memory" onto "add memory" without reading the rest of the
state is behaving exactly as designed.

## 6. Option count is not the limiting factor; I was wrong about that

An earlier draft of this page blamed a documented `choice:11+` temperature clamp for a bad
result, then isolated the variable: **34 labels beat a hand-picked 10** on the same input.
The clamp is real and laya does warn about it. The harm I attributed to it was not
measurable, and the actual cause was a bad `state`.

Keep the vocabulary you actually use. Do not prune it to satisfy a warning.

## 7. Small option sets are not automatically safe

A `choice` with two options is a coin flip dressed as a classifier. The measurements here
are dominated by 2–4 option questions, and a two-option question that is genuinely 50/50
will produce a confident-looking 0.6 that means nothing. Check the spread of
`probabilities`, not the presence of a winner.

## 8. `risk_when_wrong: high` with `human_review: none` is a smell

The frontmatter carries both fields for every use case, and this combination — a wrong
answer that destroys work, with no human reading it — is allowed only deliberately. Secret
scanning is exactly that shape and earns it. Most things are not.

If you are adding a use case and cannot say which of the two fields is doing the work, the
note is not finished.

## 9. Do not average engines

Measured on the same 44 cases: rizzo alone 86.4%, three-model majority 65.9%. A majority
vote loses 20 points, because two weaker engines outvote the stronger one on exactly the
cases it finds difficult. The ceiling for any router is 93.2% — three cases above rizzo
alone — so there is almost nothing to win and a realistic strategy loses a lot.

If you want redundancy, make it conditional: one engine answers, and only its
low-confidence tail escalates.

## See also

[What a model has to provide](compatibility.md) · [Answer payload](answer-payload.md) ·
[Choosing an engine](../patterns/choosing-an-engine.md) ·
[the measured comparison](https://micahn.github.io/onesystem-ab/)
