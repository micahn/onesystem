---
id: review-finding-kind
title: Hard violation or judgement call
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [noul]
status: candidate
human_review: required
risk_when_wrong: medium
skills: [code-review]
trigger: "A review finding has been drafted and needs classifying as hard violation versus judgement call, per finding."
tags: [use-case, review]
---

# Hard violation or judgement call

`code-review` L64 draws the line explicitly:

> Distinguish hard violations from judgement calls: documented-standard breaches can be
> hard, but baseline smells are always judgement calls, and a documented repo standard
> overrides the baseline.

Each finding needs classifying *individually*, which is a per-finding `noul`.

## Payload

```json
{
  "state": {
    "finding": "src/barrel.ts re-exports everything from every module, including the deprecated ones",
    "documented_standard": "AGENTS.md: 'barrel files must not re-export deprecated modules'",
    "standard_is_documented": true,
    "enforced_by_tooling": false,
    "repo_standard_overrides_baseline": true
  },
  "questions": {
    "is_hard_violation": {
      "type": "noul",
      "instructions": "Is this a hard violation of a documented project standard, rather than a judgement call against a baseline heuristic?"
    },
    "enforced_by_tooling": {
      "type": "noul",
      "instructions": "Is this already enforced by a linter, type checker, or other automated tool, making it not worth reporting?"
    },
    "is_judgement_call": {
      "type": "noul",
      "instructions": "Is this a baseline smell or general code-quality heuristic, which is always a judgement call rather than a hard violation?"
    }
  }
}
```

## Caveats

- `enforced_by_tooling` is a filter, not a judgement: `code-review` L41 says to *"skip
  anything tooling already enforces"*. Run it **first**. A finding that a linter catches
  should not consume review attention.
- `repo_standard_overrides_baseline` in the state is doing real work. If the repo has a
  documented standard that permits what the baseline smell dislikes, the finding is not a
  violation at all. Laya has not read `AGENTS.md`; you have to tell it.
- Per-finding means per-call or per-question-id. A review with eight findings is eight
  question ids in one pass.

## See also

[use-cases/review-worst-in-axis](review-worst-in-axis.md) · [use-cases/review-smell-which](review-smell-which.md) ·
[use-cases/review-finding-noop](review-finding-noop.md)
