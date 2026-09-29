---
id: deepening-candidate-rank
title: Which candidate to deepen
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [score]
status: candidate
human_review: optional
risk_when_wrong: low
skills: [improve-codebase-architecture, codebase-design]
trigger: "The architecture scan has produced deepening candidates that need ordering before the user picks one to grill."
tags: [use-case, deepening]
---

# Which candidate to deepen

`improve-codebase-architecture` produces an HTML report of deepening candidates and then
grills whichever one the user picks. The ranking that produces the report's order is
unstated and unsorted — which makes it a `score`.

`codebase-design` supplies the vocabulary: a deep module has a small interface and hides
more than it exposes.

## Payload

```json
{
  "state": {
    "goal": "make the codebase easier for an agent to navigate and change safely",
    "candidates": [
      {"id": "C1", "name": "src/api/routes.ts", "lines": 640, "exports": 31, "consumers": 9,
       "note": "every route handler, plus auth, plus validation, in one file"},
      {"id": "C2", "name": "src/state/store.ts", "lines": 210, "exports": 12, "consumers": 22,
       "note": "read path is clean; the write path reaches into internals of 6 slices"},
      {"id": "C3", "name": "src/util/misc.ts", "lines": 380, "exports": 44, "consumers": 40,
       "note": "a genuine junk drawer, but nothing depends on its structure"}
    ]
  },
  "questions": {
    "C1": { "type": "score", "instructions": "How much would deepening this module improve the codebase?",
            "criteria": ["no benefit", "marginal", "clear benefit", "large benefit: hides much more than it exposes"] },
    "C2": { "type": "score", "instructions": "How much would deepening this module improve the codebase?",
            "criteria": ["no benefit", "marginal", "clear benefit", "large benefit: hides much more than it exposes"] },
    "C3": { "type": "score", "instructions": "How much would deepening this module improve the codebase?",
            "criteria": ["no benefit", "marginal", "clear benefit", "large benefit: hides much more than it exposes"] }
  }
}
```

## Caveats

- **`exports` and `consumers` are the features doing the work.** A 640-line file with 31
  exports and 9 consumers is deep-hosting-in-waiting; a 380-line junk drawer with 44
  exports and 40 consumers is wide and shallow. Put the numbers in `state`.
- Note the trap: C3 has the worst metrics and probably the least payoff, because nothing
  depends on its structure. "Worst by the numbers" and "most worth fixing" diverge. This
  is the question where adding a `noul` about blast radius pays:
  `{"type": "noul", "instructions": "Would deepening this change the interface that existing consumers depend on?"}`.
- The user still picks. Laya orders the list; the skill then grills the choice with them.
  `human_review: optional`, `risk_when_wrong: low` — the cost of a bad order is a slightly
  worse report.

## See also

[use-cases/review-smell-which](review-smell-which.md) · [use-cases/frontier-priority](frontier-priority.md) ·
[use-cases/prototype-branch](prototype-branch.md)
