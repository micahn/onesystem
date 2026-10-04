---
id: self-search
title: Searching this wiki
kind: pattern
surface: [mcp, http]
tools: [predict]
# Calls 1-3 are plain `predict` and run on any engine that takes an object state.
# Call 4 is laya's `route` tool and is marked as such where it appears.
engines: [rizzo]
question_types: [choice, noul]
tags: [pattern, self-search, meta, index]
status: current
---

# Searching this wiki

The point of `index/usecases.json` is that an engine can rank this wiki's own use cases
against a live situation, pick the ones that apply, and tell you which ones do not. That
sounds circular and is not: the index is a *taxonomy of decision points*, and the live
situation is an *instance* of one. Matching an instance to a taxonomy is exactly the job
a classifier is good at.

## The shape of it

`index/usecases.json` has two blocks:

| Block | Shape | Purpose |
|---|---|---|
| `criteria` | `{"label": "one-sentence gloss"}` | **Drop-in valid** as a `choice` question's criteria. This is the ranking surface. |
| `use_cases` | array of records | Full metadata per use case: tools, question types, status, `human_review`, `risk_when_wrong`, skills, projects, note path. |

The `criteria` block is the important one. It is not "close to" a valid criteria object —
it *is* one, so there is no adapter, no translation layer, and nothing to keep in sync
beyond adding the entry.

## Call 1: the drop-in, from MCP

```json
{
  "state": {
    "situation": "Issue titled 'search returns wrong results when the query has two spaces'. Body: two paragraphs plus a reproduction snippet. No labels applied. About to start an agent on it.",
    "repo": "worldgrab",
    "tracker": "local markdown under .scratch/"
  },
  "questions": {
    "applies": {
      "type": "choice",
      "instructions": "Which documented use case should be used for this situation?",
      "criteria": { "...the contents of index/usecases.json .criteria, verbatim..." }
    }
  }
}
```

Measured result, unshortlisted, all 34 options:

```
winner        wiki-usecase-rank        <- wrong
top prob      0.2289
confidence    0.1997                   <- the model reporting it has no idea
latency       30.7 ms
```

Before copying this call, read the measurements below and the full post-mortem in
[patterns/ranking-with-shortlist](ranking-with-shortlist.md). Short version: 34 labels is fine and `state` quality is everything. The `confidence` figure in that table
was measured on laya, where it is **not** a usable gate. That is an engine-specific fact and
it does not hold everywhere — see [choosing an engine](choosing-an-engine.md).

## Call 2: adding a cheap orthogonal signal

A `choice` gives you the winner; a `noul` in the same call gives you permission to act.
Same forward pass, so it is nearly free — this is
[patterns/multi-question-batches](multi-question-batches.md) in practice.

```json
{
  "state": { "...same..." },
  "questions": {
    "applies":   { "type": "choice", "instructions": "Which documented use case applies?", "criteria": { ... } },
    "is_a_ticket": { "type": "noul", "instructions": "Is this a tracked piece of work with an owner, rather than a stray observation?" },
    "needs_human": { "type": "noul", "instructions": "Does applying the chosen use case require a human decision before work starts?" }
  }
}
```

`is_a_ticket` and `needs_human` are exactly the fields this wiki records as
`human_review: required` in [the frontmatter contract](../index/schema.md). Asking for them
directly means the caller can route on `needs_human` without first parsing a note.

## Call 3: the negative question

The more useful half of "which use case applies" is "which do **not**". `noul` handles
that cleanly, and one call can carry several exclusions:

```json
{
  "applies_code_review":      { "type": "noul", "instructions": "Is this situation a code review of an existing diff?" },
  "applies_bug_diagnosis":    { "type": "noul", "instructions": "Is this situation debugging a specific known failure?" },
  "is_open_question":         { "type": "noul", "instructions": "Is there a specific question to answer, rather than open-ended work?" }
}
```

Excluding the wrong workflow is cheap insurance. `code-review` and `diagnosing-bugs` have
genuinely different rituals — a two-axis review with a deliberate refusal to rerank across
axes, versus red-green-minimise-hypothesise — and picking the wrong one wastes a cycle.

## Call 4: routing first, when the language is uncertain — laya only

**laya only.** laya ships a language router the other two engines do not, and it is free
— no forward pass. If you do not know what language the incoming situation is in:

```json
{ "state": { ... }, "questions": { "applies": { ... } } }
```

→ `{model, repo, reason}`. The `reason` is explanatory ("non-Latin script (bengali, 100% of
letters); the English checkpoint cannot read it"), which makes it a good thing to show a
user who is surprised. See [use-cases/checkpoint-route-explain](../use-cases/checkpoint-route-explain.md).

## Measured — and two uncomfortable findings

All at 34 labels, no shortlist, varying only the `state`. Each situation is the same
underlying facts, written two ways:

| Situation | Variant | Winner | Top prob | Confidence | Correct |
|---|---|---|---|---|---|
| triage | focused | `ticket-gate` | 0.9644 | 0.9445 | **yes** |
| triage | verbose | `prose-ai-pattern` | 0.3059 | 0.3415 | no |
| push | focused | `pre-push-secret-triage` | 0.9875 | 0.9808 | **yes** |
| push | verbose | `acceptance-criteria-checkable` | 0.3603 | 0.6173 | no |
| injection | focused | `doc-done-criteria-clear` | 0.8803 | 0.8877 | no |
| injection | verbose | `wiki-usecase-rank` | 0.9912 | 0.9822 | no |

1. **A padded `state` tends to be worse than a focused one — 2 of 3, by a wide margin.**
   Triage: 0.9644 against 0.3059. Push: 0.9875 against 0.3603. Metadata and restatement
   mislead the ranker.

   The third row pair is the honest counter-case, and it matters more than the two wins:
   on the injection case the verbose state scored **higher** (0.9912 vs 0.8803) and was
   still wrong — as was the focused one. So the rule is "padding tends to hurt", not
   "padding always hurts", and neither variant found `untrusted-content-injection`, which
   is the correct answer for all three injection states. Full analysis in
   [patterns/ranking-with-shortlist](ranking-with-shortlist.md).
2. **34 labels is not the problem.** With a focused state, 34 labels scored *higher*
   (0.9644) than a hand-picked 10-label subset (0.7047) on the same input.

## Confidence is not a gate

The first draft of this note recommended gating on `confidence` and falling back to a human
below roughly `0.25`, on the theory that every wrong answer seen so far was also a
low-confidence one. **That was wrong, and dangerously so.**

The most confident answer in the table above — `0.9912` top probability, `0.9822`
confidence — is wrong, and it is wrong about the one case that no variant got right.
Meanwhile a correct answer elsewhere came back at `0.5103`.

So for taxonomy matching:

- `confidence` is **not** a reliability estimate you can threshold.
- High `confidence` means the model is *sure*, which is not the same as being *right*. It
  is worst precisely where the mapping is systematically mislearned, because that is where
  it is most sure.
- The only signal that carried information was the **gap between the top two
  probabilities**: wide means the answer is usually usable, narrow means the distinction is
  not being made. That measures decisiveness, not correctness.

This is why [use-cases/wiki-usecase-rank](../use-cases/wiki-usecase-rank.md) is `human_review: required` and
`risk_when_wrong: medium`. It is a routing aid, and whoever receives the routing checks it.

It is also the sharpest confirmation of the rule already in
`~/Projects/breath/AGENTS.md`: *"Trust it above intuition only when its confidence is high;
the code outranks it."* The data says the first clause is the dangerous one. Keep the
second.

## Reading the answer honestly

1. **Check the winner against your own reading of the situation.** The only reliable check,
   and cheap — you understood the situation well enough to write the `state`.
2. **Look at the gap between the top two probabilities.** Narrow means the distinction is
   not being made.
3. **Write the tightest `state` you can.** More text is not more information here. This is
   the highest-leverage change available and it costs nothing.
4. **Never read `action.act_probability`.** It is `1.0` always. See
   [reference/guardrails](../reference/guardrails.md#the-act_probability-trap).
5. **Do not shortlist at this size.** Measured 30.7 ms versus 2224 ms, with worse answers.
   See [patterns/ranking-with-shortlist](ranking-with-shortlist.md).

## Keeping the index honest

The index is only useful if it is true. Two failure modes to watch:

- **Drift.** A note gets a new `status` and the index does not. The
  `human_review` field is the one that matters most and the one most likely to rot.
- **Label meaning drift.** Labels in `criteria` are choice labels. If
  `triage-state` silently starts meaning something slightly different, every stored
  probability for it becomes meaningless. This is why the schema says labels are stable
  and why `id` is never renamed.

`scripts/validate.py` checks the structural invariants — the file parses, every `criteria`
key has a record, every record has a note, `count` matches. It does not and cannot check
whether a gloss is still *true*. That is a human job, which is the correct division of
labour for a wiki.

## Why not a search index

The obvious alternative is embeddings over the notes. It was rejected because:

- The notes are prose written for humans. Their similarity is topical, not
  *decision-shaped*. "Which use case applies" is not a similarity question between
  documents, it is a classification question over a taxonomy.
- A `grep` for `triage` finds the triage notes. What is missing is not retrieval, it is
  *discrimination* — telling `triage-state` from `ticket-gate` from
  `frontier-priority`, which are three different decisions that share vocabulary. That is
  what the probabilities are for.
- One JSON file is one read. Thirty notes would be thirty reads and a hand-rolled
  embedder every time.

## See also

- [index/schema](../index/schema.md) — the field contract
- [patterns/ranking-with-shortlist](ranking-with-shortlist.md) — why the naive call fails, measured
- [use-cases/wiki-usecase-rank](../use-cases/wiki-usecase-rank.md) — the use case itself
- [patterns/multi-question-batches](multi-question-batches.md) — why the extra `noul` questions are nearly free
