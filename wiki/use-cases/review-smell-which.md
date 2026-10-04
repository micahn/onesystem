---
id: review-smell-which
title: Which Fowler smell
kind: use-case
surface: [mcp]
tools: [predict, laya_route]
# Only laya. Uses a laya-only tool; see reference/compatibility for what that costs.
engines: [laya]
question_types: [choice]
status: candidate
human_review: required
risk_when_wrong: medium
skills: [code-review, codebase-design]
trigger: "Naming which of the twelve Fowler smells a piece of code most closely is. Twelve labels is the practical ceiling for an unshortlisted choice question."
tags: [use-case, review]
---

# Which Fowler smell

`code-review` L45-56 lists twelve Fowler smells as *"a labelled heuristic ('possible
Feature
Envy'), never a hard violation"*. That is a ready-made `choice` criteria set, and
`codebase-design` shares the vocabulary.

Twelve labels is past the `choice:11+` band laya documents and warns about (rizzo
publishes no such limit), so this note carries
that caveat. See [reference/guardrails](../reference/guardrails.md#the-`choice:11+`-temperature-clamp) — and note
that the label count is *not* the thing most likely to make this question weak. A vague
`state` is. See [patterns/ranking-with-shortlist](../patterns/ranking-with-shortlist.md).

## Payload

```json
{
  "state": {
    "code": "class Report { render() { return new Table(rows).toString() } }\nfunction buildReport(r) { return new Report(r) }"
  },
  "questions": {
    "smell": {
      "type": "choice",
      "instructions": "Which Fowler code smell does this most closely exhibit?",
      "criteria": {
        "mysterious_name": "a name that does not reveal its intent",
        "duplicated_code": "the same logic expressed more than once",
        "feature_envy": "a method that reaches at another object's data more than its own",
        "data_clumps": "the same group of variables travelling together",
        "primitive_obsession": "a primitive standing in for a domain concept",
        "repeated_switches": "the same conditional cascade on the same type",
        "shotgun_surgery": "one change requiring edits in many places",
        "divergent_change": "one reason to change requiring edits in many places",
        "speculative_generality": "abstraction built for cases that do not exist",
        "message_chains": "long chains of navigation to reach the data you want",
        "middle_man": "a function that only forwards",
        "refused_bequest": "a subclass ignoring or gutting an inherited contract",
        "no_clear_smell": "none of these fits clearly"
      }
    },
    "is_judgement_call": {
      "type": "noul",
      "instructions": "Is this a labelled heuristic rather than a hard violation, as the review standard requires?"
    }
  }
}
```

## Caveats

- **`no_clear_smell` is not a cop-out label.** Without it the model must pick the least
  bad of twelve, which produces confident noise. With it, "none fits" is a legitimate
  answer and you learn something.
- The `is_judgement_call` `noul` is always `true` by the skill's own definition — the value
  is in forcing the distinction to be *stated* per finding, which pairs with
  [use-cases/review-finding-kind](review-finding-kind.md).
- 13 labels is past the boundary laya documents, but I would **not** split it just
  to get under 10. Measured: 34 labels beat a hand-picked 10 on the same input, because
  specific glosses discriminate better than a small set of vague ones. Splitting helps
  latency and token budget, and costs accuracy when the coarse glosses are thin. If you
  do split, use glosses that carry real content — `shape`, `coupling`, `generality` — not
  bare category names.
- Laya has not seen the surrounding code. Include enough of it that the smell is visible
  in the text, or you are asking it to smell a diff.

## See also

[use-cases/review-finding-kind](review-finding-kind.md) · [use-cases/deepening-candidate-rank](deepening-candidate-rank.md) ·
[patterns/multi-question-batches](../patterns/multi-question-batches.md)
