---
id: skill-boundary-choice
title: Which flow at a boundary
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: optional
risk_when_wrong: low
skills: [ask-matt]
trigger: "A situation sits on the boundary between two skills. The ask-matt skill calls this the fuzziest decision in its whole map."
tags: [use-case, skill]
---

# Which flow at a boundary

`ask-matt` is a router over the skills, and it says where its own routing is weakest. L63:

> At the **boundary** between two of them you have five options, and picking between them
> is the fuzziest decision in this whole map.

Naming the fuzziest decision in your own map is an invitation.

## Payload

Build the criteria from the skills you are actually choosing between:

```json
{
  "state": {
    "situation": "I have a working prototype of a queue-based layout system and now need to decide whether to keep it",
    "available_flows": [
      "research",
      "prototype",
      "grilling",
      "implement",
      "code-review",
      "tdd",
      "to-spec",
      "to-tickets",
      "wayfinder",
      "handoff",
      "diagnosing-bugs"
    ]
  },
  "questions": {
    "flow": {
      "type": "choice",
      "instructions": "Which skill or flow should handle this situation?",
      "criteria": {
        "research": "the answer is out there and must be gathered from primary sources",
        "prototype": "the answer only appears once something tangible is built and tried",
        "grilling": "the answer depends on human priorities and needs a live interview",
        "implement": "the work is already specified and just needs building",
        "code-review": "work is done and needs assessing against standards and spec",
        "to-spec": "the shape of the work needs writing down before building",
        "to-tickets": "known work needs breaking into tracer-bullet slices",
        "wayfinder": "the work is too big to hold in one session and needs a decision map",
        "handoff": "the work must be compacted for another agent to pick up",
        "diagnosing-bugs": "something is broken and the cause is not yet known"
      }
    },
    "is_boundary": {
      "type": "noul",
      "instructions": "Does this situation genuinely sit on the boundary between two of these flows rather than clearly inside one?"
    }
  }
}
```

## Caveats

- **Ten labels**, at the edge of the band laya documents. See
  [reference/guardrails](../reference/guardrails.md#the-`choice:11+`-temperature-clamp). Keep the list to the flows
  actually installed, because each gloss is doing discrimination work and a padded list
  dilutes it. If it grows past ~20, split by family — planning versus building versus
  assessing — with glosses specific enough to earn the split.
- `is_boundary` is the honest bit. If it comes back `true`, the engine is telling you the
  question is a judgement call, and `ask-matt`'s own advice is to ask the user.
- This is a `score` question wearing a `choice` costume, and that is fine. What you want
  is the argmax plus a confidence reading, not a winner-take-all.

## See also

[use-cases/wiki-usecase-rank](wiki-usecase-rank.md) · [use-cases/prototype-branch](prototype-branch.md) ·
[patterns/multi-question-batches](../patterns/multi-question-batches.md)
