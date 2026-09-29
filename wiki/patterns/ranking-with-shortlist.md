---
id: ranking-with-shortlist
title: Ranking, and what actually happens at 34 options
kind: pattern
surface: [http, mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [choice, score]
tags: [pattern, ranking, shortlist, calibration, measured, corrected]
status: current
---

# Ranking, and what actually happens at 34 options

Laya's guidance is: do not use `choice` questions with more than about 20 options without
shortlisting, and `predict_shortlist` exists for that. I followed the advice on this wiki's
own 34 use cases, **measured the result, and found the guidance does not apply at this
size.** The shortlist made things worse. Everything below is measurement, including the
parts that contradicted what I expected.

## What the shortlist is for

Choice options share one `head_max_len` token budget, so a large label set leaves few
tokens per label. `predict_shortlist` is the coarse-to-fine answer:

1. **Coarse** — `shortlist_choice` embeds the query and every rendered option with a
   caller-supplied `embed_fn`, keeps the top *k* by cosine. No forward pass.
2. **Fine** — one `predict` over the survivors. Probabilities are over the kept labels
   only.

## Measurement 1: the shortlist, followed as documented

Query: *an unlabeled issue with a title, a two-paragraph body and a reproduction snippet,
about to be handed to an agent.* 34 options.

| Configuration | Winner | Top prob | Confidence | Time |
|---|---|---|---|---|
| Unshortlisted, 34 options | `wiki-usecase-rank` ❌ | 0.2289 | 0.1997 | **30.7 ms** |
| Shortlist k=8, `embed_fn_from_agent` | `debug-seam-is-real` ❌ | 0.3657 | 0.1635 | **2224 ms** |
| Shortlist k=10, `embed_fn_from_agent` | `triage-state` ✅ | 0.5149 | 0.2740 | 593 ms |
| Hand-curated 10 labels | `debug-is-real-bug` (defensible) | 0.2804 | 0.2109 | **19 ms** |

Two clear results: the shortlist was **20-70x slower**, and the `embed_fn_from_agent`
retriever **removed the correct answer** from the shortlist on one run.

The retriever's cosines explain why:

```
frontier-priority              0.9620
untrusted-content-injection    0.9592
research-claim-primary-source  0.9544
triage-state                   ~0.933
```

Everything sits in a 0.93-0.96 band. That is a compressed embedding space with almost no
discriminative spread — a ModernBERT encoder mean-pooled without contrastive training for
this task. It cannot separate these options, so the top-*k* is close to arbitrary. The
`embed_fn` docstring's hedge ("a dedicated bi-encoder will usually shortlist better") is
load-bearing.

## Measurement 2: my first conclusion was wrong

The flat 0.2289 looked like the `choice:11+` calibration cliff, so I wrote that shortlisting
to ≤10 labels was a *calibration repair*. Then I tested the option count directly, holding
the state fixed.

**Same state, different option counts:**

| State | Options | Winner | Top prob | Confidence |
|---|---|---|---|---|
| focused | **34** | `ticket-gate` ✅ | **0.9644** | 0.9445 |
| focused | 10 (hand-picked) | `triage-state` | 0.7047 | 0.5103 |

**Same options, different state quality:**

| State | Options | Winner | Top prob | Confidence |
|---|---|---|---|---|
| focused | 34 | `ticket-gate` ✅ | **0.9644** | 0.9445 |
| verbose | 34 | `prose-ai-pattern` ❌ | 0.3059 | 0.3415 |
| verbose | 10 | `debug-is-real-bug` ❌ | 0.2916 | 0.1674 |

**34 labels beat 10 labels on the same state.** The flat 0.2289 was never about the option
count. It was about the state.

## What the state difference was

The focused version: `an unlabeled issue with a repro snippet, about to be handed to an
agent`.

The verbose version added: `Issue titled 'search returns wrong results when the query has
two spaces'. Body: two paragraphs plus a reproduction snippet. No labels applied. Repo:
worldgrab. Tracker: local markdown under .scratch/.`

Both describe the same situation. The second restates it, adds metadata, and gets the
answer wrong — at every option count. A long state gives the encoder more text to attend
to, and the *extra* text wins.

**Replicated, with one honest exception.** Running the same focused-versus-verbose contrast
across three situations: focused won on triage (0.9644 vs 0.3059) and push (0.9875 vs
0.3603), but **lost** on the injection case (0.8803 vs 0.9912), where the verbose state
scored higher and both were wrong. So the finding is "padding tends to hurt", not "padding
always hurts" — and the exception is the more useful half, because a confidently wrong
answer is a worse failure than a low-confidence one. The full table is in
[patterns/self-search](self-search.md).

## Measurement 3: the hierarchical split also underperformed

Splitting the taxonomy into calibrated sub-questions should have been the safe play:

| Question | Labels | Winner | Top prob | Confidence |
|---|---|---|---|---|
| `family` | 6 | `debug` ❌ | 0.3411 | 0.1197 |
| `gate_specific` | 5 | `ticket-gate` ✅ | 0.7807 | 0.5137 |

The 5-label question was right and confident. The 6-label question was wrong and flat. Small
label sets are **not** automatically easier: with fewer options, the glosses have to carry
all the discrimination on their own, and a vague gloss like "sorting incoming issues" is
hopeless where 34 specific glosses would have been fine.

I also recommended this in `patterns/multi-question-batches.md`. That recommendation was
wrong and has been corrected.

## Conclusions

**1. At ~35 options, do not shortlist. Just ask.** 30.7 ms versus 2224 ms, and better
answers. `embed_fn_from_agent` costs more than the decision it enables, because it
tokenises and encodes 35 texts with no caching, and it silently drops correct answers.
Shortlisting is for hundreds of options, with a real bi-encoder, or with cached embeddings.

**2. `state` construction is the biggest lever.** More than question wording, more than
label count, more than the choice of question type — it won 2 of 3 replications, by 0.63
and 0.66. Write the state as a short, focused description. Do not include metadata, do not
restate the question, do not paste the whole ticket. The one case it lost is documented
above, because that case is the one that teaches something.

**3. A weak retriever is worse than no retriever.** It removes the correct answer with no
warning. If you do shortlist, print the cosines. A narrow band means the ranking is noise.

**4. Guard rails around the `choice:11+` clamp are not a shortlisting argument.** The clamp
in `rl_agent_config.json` is a real fact and Laya does warn about it at load. But I could
not demonstrate that it degrades answers at 34 options — the distributions above reach 0.99
at 34 labels. Treat it as an unquantified caveat, not a measured harm. See
[reference/guardrails](../reference/guardrails.md#the-`choice:11+`-temperature-clamp).

**5. Confidence does not protect you.** See
[self-search](self-search.md#confidence-is-not-a-gate) — the two most confident
answers I measured were both wrong, at 0.974 and 0.982.

## Practical guidance

| Situation | Do |
|---|---|
| Up to a few hundred options | Just `predict`. Measure the answer quality before optimising. |
| Any option count | Write the tightest `state` you can. This is the highest-leverage thing by a wide margin. |
| Hundreds of options *and* measured slowness | Shortlist with a real bi-encoder, `k=10`, and **inspect the cosines**. |
| 100+ options, repeated calls | Shortlist *and* cache the option embeddings. The retriever becomes the bottleneck. |
| Any of the above | Read `probabilities`. Sanity-check the winner yourself. Do not gate on `confidence` alone. |

## The recipe, for when you actually need it

```python
import json
import laya
from laya.shortlist import embed_fn_from_agent, predict_shortlist, shortlist_choice

INDEX = json.load(open("index/usecases.json"))
CRITERIA = INDEX["criteria"]

router = laya.Router(device="cuda")
router.preload(["english"])
agent = router.load("english")

state = {"situation": "an unlabeled issue, about to be handed to an agent"}

embed_fn = embed_fn_from_agent(agent)
out = predict_shortlist(router, state, {
    "applies": {
        "type": "choice",
        "instructions": "Which documented Laya use case applies to this situation?",
        "criteria": CRITERIA,
    }
}, embed_fn, k=10)

meta = out["shortlist"]["applies"]
print("kept:   ", meta["labels"])
print("cosines:", meta["scores"])   # <-- INSPECT THESE BEFORE TRUSTING THE WINNER
print("winner: ", out["answers"]["applies"]["choice"],
      out["answers"]["applies"]["probabilities"])
```

`predict_shortlist` returns `shortlist: {labels, scores, k, n, passthrough}`. When `k >= n`
it returns everything in order, sets `scores` to `None`, and never calls `embed_fn` — so
the same code path handles small option sets for free.

## See also

- [patterns/self-search](self-search.md) — the confidence finding
- [reference/guardrails](../reference/guardrails.md) — reading weak answers
- [use-cases/wiki-usecase-rank](../use-cases/wiki-usecase-rank.md) — the use case that started this
- [patterns/multi-question-batches](multi-question-batches.md) — corrected
