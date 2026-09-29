---
id: spec-readiness
title: Is a spec ready for an agent
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [choice, noul]
status: candidate
human_review: required
risk_when_wrong: medium
skills: [to-spec, triage]
trigger: "A spec has just been written and is about to be labelled ready-for-agent, which to-spec currently does without checking."
tags: [use-case, spec]
---

# Is a spec ready for an agent

`to-spec` SKILL.md L19 says: *"Apply the `ready-for-agent` triage label - no need for
additional triage."* That is a deliberate shortcut, and on a well-formed spec it is
correct. The gap is that **nothing checks**. A spec that is internally consistent but
under-specified still gets labelled ready, and the cost lands later as a confused agent
mid-implementation.

This use case is the check `to-spec` currently skips.

## Payload

```json
{
  "state": {
    "spec": "<full spec text>",
    "has_open_questions_section": false,
    "has_acceptance_criteria": true,
    "acceptance_criteria": ["--json prints the raw payload", "human output unchanged by default"]
  },
  "questions": {
    "ready": {
      "type": "choice",
      "instructions": "Is this spec complete and unambiguous enough to hand to an implementing agent without further questions?",
      "criteria": {
        "ready": "an agent could implement this end to end without asking a question",
        "needs_scope": "the boundaries or non-goals are unclear",
        "needs_criteria": "there is no way to tell when it is finished",
        "needs_decisions": "it defers a decision that must be made first"
      }
    },
    "ambiguity": {
      "type": "score",
      "instructions": "How much ambiguity is left in this spec?",
      "criteria": [
        "unambiguous: one reading only",
        "slight: one term could be read two ways",
        "real: several parts have more than one reading",
        "severe: an agent would have to invent the design"
      ]
    }
  }
}
```

## Caveats

- Four labels here, comfortably calibrated. Do not add a fifth "needs_estimate".
- The `needs_decisions` label is the valuable one: it catches the spec that defers
  something the implementer cannot defer.
- This is `human_review: required`. `to-spec` ends with the user approving the spec; this
  question is a prior, not a replacement.

## See also

[use-cases/ticket-gate](ticket-gate.md) · [use-cases/doc-done-criteria-clear](doc-done-criteria-clear.md) ·
[use-cases/decision-ticket-optional](decision-ticket-optional.md)
