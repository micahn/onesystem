---
id: multi-question-batches
title: Multi-question batches and hierarchical labels
kind: pattern
surface: [mcp, http, http]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [rizzo]
question_types: [choice, score, noul]
tags: [pattern, batching, performance, calibration]
status: current
---

# Multi-question batches and hierarchical labels

Every question in one call is answered in **one forward pass**. That is the single most
useful performance fact about Laya, and it changes how you should design questions.

## Batching is nearly free

Three questions cost about what one costs:

```json
{
  "state": { "ticket": "...", "diff": "..." },
  "questions": {
    "ready":       { "type": "choice", "instructions": "...", "criteria": { ... } },
    "risk":        { "type": "score",  "instructions": "...", "criteria": ["...", "...", "...", "..."] },
    "needs_design":{ "type": "noul",   "instructions": "..." }
  }
}
```

Measured: 3 questions, 30-1233 ms depending on checkpoint warmth. Compare with three
separate calls, which pay three routings and — if the checkpoint were ever evicted between
them — potentially three cold loads.

This is why [patterns/self-search](self-search.md) can afford a `choice` plus two `noul` questions and
still be a single round trip. Design the question set as one batch; do not discover
questions one at a time.

The cost that *does* scale with question count is the shared `head_max_len` budget for
options. More choice options means fewer tokens each. In practice I could not measure this
hurting answer quality at 34 labels — see
[conclusion 2](ranking-with-shortlist.md#conclusions) — but it is a real budget and
it is why a very large taxonomy is worth splitting.

## Hierarchical labels: the theory, and what actually happened

Splitting a taxonomy into stages looks obviously right: fewer labels per question, each in
the range laya documents, all in one forward pass.

```json
{
  "questions": {
    "family":  { "type": "choice", "instructions": "Which workflow family is this?",
                 "criteria": { "gates": "deciding whether work may start",
                               "triage": "sorting incoming issues",
                               "debug": "chasing a known failure",
                               "review": "assessing existing work",
                               "filters": "blocking unsafe or injected content",
                               "meta": "deciding which process or tool to use" } },
    "specific":{ "type": "choice", "instructions": "Given that family, which specific check applies?",
                 "criteria": { ... 5 labels for the family the state is in ... } }
  }
}
```

I wrote this note recommending that approach, then tested it. On this wiki's own 34 use
cases:

| Question | Labels | Winner | Top prob | Confidence |
|---|---|---|---|---|
| `family` | 6 | `debug` ❌ | 0.3411 | 0.1197 |
| `gate_specific` | 5 | `ticket-gate` ✅ | 0.7807 | 0.5137 |

The 5-label question was right and confident. The 6-label question was wrong and flat.
**Small label sets are not automatically easier.** With fewer options, each gloss has to
carry all the discrimination alone, and a gloss like `"sorting incoming issues"` is
hopeless where 34 specific glosses would have been fine.

Compare the same situation as a single 34-label question with the same focused state:
`0.9644`, correct.

So the revised guidance:

- **Splitting is not a free accuracy win.** It is a latency and token-budget win, and it
  costs accuracy when your coarse glosses are vague.
- **Split it if the coarse question is genuinely easy to state**, with glosses that carry
  real discriminating content. `"gates: deciding whether work may start"` is usable;
  `"spec: ..."` is not.
- **Do not split a taxonomy that already works as one question.** 34 labels with specific
  glosses beat 6 vague ones.
- **Write specific glosses either way.** This is the finding underneath all of it: gloss
  quality and `state` quality dominate. Label count is third.

## The `noul` companion

A `choice` tells you *which*. A `noul` in the same batch tells you *whether to act on it*.
They cost the same forward pass, so there is no reason to make a second call.

```json
{
  "applies":  { "type": "choice", "instructions": "Which use case applies?", "criteria": { ... } },
  "clear_enough_to_act": { "type": "noul", "instructions": "Is the situation specific enough that a decision can be made without asking a human?" },
  "would_change_code":   { "type": "noul", "instructions": "Would acting on this touch code or published artifacts?" }
}
```

`would_change_code` is a cheap blast-radius check. It is the same shape as the `guard`
preset's `sensitive_data` and it generalises: anything that will modify code, delete data,
or publish should be able to answer "is this safe to just do?" in one number.

## Batch many states, not many calls

laya's `predict_batch` exists for many states under one question set — batch-triage 200
issues, score every ticket. It is laya-only, so the portable form of this pattern is one
call with one question per candidate, which is what
[frontier-priority](../use-cases/frontier-priority.md) does. Measured caveat from the batch
path: at 4 short states the speedup was only **1.1x**, and batch and sequential answers
differed in the third decimal. So: below roughly 50 states the throughput win does not
justify restructuring code, and if you cache results, do not assume batch and non-batch
results are interchangeable. See [the models page](../reference/models.md).

## Checklist for designing a batch

- [ ] One call, all questions. Never loop over questions.
- [ ] Write the tightest `state` you can. Measured: this dominates everything else on the
      list. A verbose restatement of the same situation scored 0.3059 where the focused
      version scored 0.9644.
- [ ] Give every question an `instructions` string that is a complete sentence. It is
      rendered into the input; a vague instruction produces a confident answer to a vague
      question.
- [ ] Make the `criteria` descriptions *discriminative*, and specific. "a bug" and "an
      enhancement" will not separate; write the boundary into the gloss. This is the second
      biggest lever after `state`.
- [ ] Prefer one `choice` with many specific labels over several `choice`s with few vague
      ones. Measured: 34 specific labels beat 6 vague ones.
- [ ] Pair every `choice` with a `noul` that says whether to act on it. Nearly free, same
      forward pass.
- [ ] Read `probabilities` for every question, and the gap between the top two. Do **not**
      gate on `confidence` alone — the most confident answers measured were wrong.

## See also

- [patterns/ranking-with-shortlist](ranking-with-shortlist.md) — the measurements behind most of this list
- [reference/answer-payload](../reference/answer-payload.md) — the per-type field reference
- [patterns/self-search](self-search.md) — this pattern applied to the wiki itself
- [reference/guardrails](../reference/guardrails.md) — why confidence is not a gate
