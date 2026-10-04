---
id: acceptance-criteria-checkable
title: Are acceptance criteria checkable
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [noul, score]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [writing-for-agents, to-spec, tdd]
trigger: "Acceptance criteria have been written and the agent needs to know when it is finished."
tags: [use-case, acceptance]
---

# Are acceptance criteria checkable

`writing-for-agents` L52: *"The strongest criteria are both checkable and exhaustive."*
L49 adds that a vague bound *"invites premature completion"*. Two properties, two
questions, one forward pass.

## Payload

```json
{
  "state": {
    "criteria": [
      "the endpoint returns 200",
      "response time stays under 200ms",
      "errors are handled gracefully",
      "the change is well tested"
    ]
  },
  "questions": {
    "checkable": {
      "type": "noul",
      "instructions": "Can a machine or a command determine, without asking a human, whether each of these criteria is met?"
    },
    "exhaustive": {
      "type": "noul",
      "instructions": "Do these criteria together cover everything that must be true when the work is done, with no important requirement left unstated?"
    },
    "clarity": {
      "type": "score",
      "instructions": "How clear is the boundary between done and not-done?",
      "criteria": [
        "unambiguous: done is obvious",
        "mostly clear: one criterion needs interpretation",
        "fuzzy: a reader could reasonably disagree about done",
        "vague: 'working', 'robust', 'fast enough' with no number"
      ]
    }
  }
}
```

## Caveats

- Put the criteria as a **list** in `state`. Laya reads structure, and a numbered list is
  what it was trained on for this shape.
- `clarity` is a `score`, and the level texts do the work — they enumerate the actual
  failure modes. Write rubrics that name the bad thing, not just the good thing.
- This pairs with [use-cases/doc-done-criteria-clear](doc-done-criteria-clear.md): one grades a spec's criteria,
  the other grades a document's completion bound.

## See also

[use-cases/doc-done-criteria-clear](doc-done-criteria-clear.md) · [use-cases/ticket-gate](ticket-gate.md) ·
[use-cases/spec-readiness](spec-readiness.md)
