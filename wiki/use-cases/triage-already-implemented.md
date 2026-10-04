---
id: triage-already-implemented
title: Already implemented or rejected
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [noul, choice]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [triage]
trigger: "Checking for redundancy in the codebase and for prior rejections under .out-of-scope/."
tags: [use-case, triage]
---

# Already implemented or rejected

`triage` L70 describes two checks: **(a) redundancy** — is it already implemented, which
makes it an already-implemented `wontfix`; and **(b) prior rejection** — read
`.out-of-scope/*.md` and surface anything resembling this request.

`oma-bear/AGENTS.md` records a case where this mattered: *"prototyped and REJECTED — do
not reintroduce without a new ask."*

## Payload

```json
{
  "state": {
    "request": "let the user drag the bowl to a new position on screen",
    "code_search_result": "found DragHandler in src/bowl.qml, handles mouse and touch drag with clamping",
    "out_of_scope_notes": [
      ".out-of-scope/2026-08-bowl-follows-cursor.md — bowl follows cursor instead"
    ]
  },
  "questions": {
    "already_implemented": {
      "type": "noul",
      "instructions": "Does the codebase already implement what this request asks for?"
    },
    "previously_rejected": {
      "type": "noul",
      "instructions": "Does a prior rejection or out-of-scope note cover this request closely enough that reviving it needs a new ask from the user?"
    },
    "wontfix": {
      "type": "noul",
      "instructions": "Should this be closed as wontfix on the grounds that it is already implemented or previously rejected?"
    }
  }
}
```

## Caveats

- Two evidence fields, two derived questions, one conclusion. The `wontfix` question is a
  conjunction of the first two — but ask all three so the payload records *which* leg
  fired.
- `previously_rejected` is the more valuable of the two and the more neglected. Grepping
  `.out-of-scope/` is exactly the kind of step an agent skips, and exactly the kind of
  institutional memory that gets lost.
- This is `human_review: optional`: a `wontfix` closure is visible and reversible, and the
  skill's own flow already surfaces the recommendation.

## See also

[use-cases/triage-claim-holds](triage-claim-holds.md) · [use-cases/triage-state](triage-state.md)
