---
id: ticket-gate
title: Gate a ticket before implementing
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [choice, noul]
status: proven
human_review: required
risk_when_wrong: low
skills: [implement, to-tickets]
trigger: "A ticket is about to be picked up by an agent, and the question is whether it is worth starting."
tags: [use-case, ticket]
---

# Gate a ticket before implementing

The single highest-value use case in this wiki, and the one already written into
`~/Projects/breath/AGENTS.md`. Every wasted agent run is a wasted agent run, and this
question is cheap enough (33 ms) to ask before every single one.

## Payload

```json
{
  "state": {
    "title": "add a --json flag to the laya CLI",
    "body": "The CLI prints human-readable output only. Piping it into jq is impossible. Add --json.",
    "repo": "laya",
    "tracker": "GitHub Issues"
  },
  "questions": {
    "ready": {
      "type": "choice",
      "instructions": "Is this ticket ready for an agent to implement?",
      "criteria": {
        "ready": "has clear scope and acceptance criteria",
        "needs_scope": "scope is vague or missing",
        "needs_criteria": "no testable acceptance criteria"
      }
    },
    "risk": {
      "type": "score",
      "instructions": "How risky is implementing this change?",
      "criteria": [
        "trivial: no behaviour change",
        "low: purely additive",
        "medium: changes existing behaviour",
        "high: breaking or destructive"
      ]
    },
    "needs_design": {
      "type": "noul",
      "instructions": "Does this change need a design decision before any code is written?"
    }
  }
}
```

## Measured

| Question | Answer | Confidence |
|---|---|---|
| `ready` | `ready` (0.8128) | 0.4438 |
| `risk` | 1.5702 of 0-3, mass on `medium` (0.5297) | 0.2674 |
| `needs_design` | 0.2548, i.e. fairly sure it does **not** | 0.7452 |

Note how the two `noul`-flavoured questions read very differently. `needs_design` at
`0.2548` carries confidence `0.7452` because `noul` confidence is `max(p, 1-p)` and a
confident *negative* scores high. Do not read that as inconsistency.

## Caveats

- **`state` is the whole game.** A ticket body that omits the acceptance criteria will
  come back `needs_criteria` for the right reason and the wrong reason. Include the
  criteria in `state` if you want them judged.
- `risk` is a `score` with 4 levels. Three to five is the range laya documents; rizzo
  publishes no limit of its own.
- Read `probabilities`, not just `choice`. If `ready` and `needs_scope` are within 0.1,
  the ticket is genuinely ambiguous and a human should look.

## See also

[use-cases/spec-readiness](spec-readiness.md) · [use-cases/acceptance-criteria-checkable](acceptance-criteria-checkable.md) ·
[patterns/multi-question-batches](../patterns/multi-question-batches.md)
