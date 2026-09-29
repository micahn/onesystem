---
id: review-worst-in-axis
title: Worst finding in an axis
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [score]
status: candidate
human_review: optional
risk_when_wrong: low
skills: [code-review]
trigger: "Ordering findings within one review axis. Never across axes: the two-axis separation exists to prevent exactly that reranking."
tags: [use-case, review]
---

# Worst finding in an axis

The one place in this wiki where an explicit prohibition matters as much as the payload.

`code-review` L78:

> End with a one-line summary: total findings per axis, and the worst issue *within each
> axis* (if any). **Don't pick a single winner across axes: that's the reranking the
> separation exists to prevent.**

So this scores **within** one axis. Never run a cross-axis "how bad is this review overall"
question — that deletes the feature the skill was built around.

## Payload

```json
{
  "state": {
    "axis": "Standards",
    "findings": [
      {"id": "S1", "text": "barrel re-exports deprecated modules", "hard": true},
      {"id": "S2", "text": "four functions over 120 lines", "hard": false},
      {"id": "S3", "text": "comment restates the code", "hard": true}
    ]
  },
  "questions": {
    "worst": {
      "type": "score",
      "instructions": "How serious is this finding within this axis?",
      "criteria": [
        "cosmetic: style preference, no consequence",
        "minor: real but low impact",
        "serious: documented standard breached, or a defect waiting to happen",
        "blocking: must be fixed before merge"
      ]
    },
    "worth_reporting": {
      "type": "noul",
      "instructions": "Is this finding worth a reviewer's attention at all, rather than being noise or already covered by another finding?"
    }
  }
}
```

## Caveats

- One `worst` question **per finding**, all in one call: `worst_S1`, `worst_S2`,
  `worst_S3`. That is the whole throughput trick.
- `axis` belongs in `state` so the model knows the scale. "Standards" findings and "Spec"
  findings are not comparable, and that is the point.
- `worth_reporting` deduplicates. Reviews accumulate overlapping findings and the summary
  line should count distinct problems.

## See also

[use-cases/review-finding-kind](review-finding-kind.md) · [why not to rerank](../patterns/wiring-into-skills.md#1.-do-not-rerank-across
review-axes)
