---
id: fog-or-ticket
title: Fog or ticket
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [wayfinder]
trigger: "Something unknown has surfaced during a wayfinding session and needs to become a ticket or stay fog."
tags: [use-case, fog]
---

# Fog or ticket

`wayfinder` L88 gives an unusually crisp test:

> **Fog or ticket?** The test is whether you can state the question precisely now, *not*
> whether you can answer it now.

That is a `choice` between two labels, and the framing matters: the question is about
*stating* it, not solving it.

## Payload

```json
{
  "state": {
    "fog": "something about how the mod loader pins to Steam buildids is not working",
    "attempted_statement": null,
    "related_tickets": ["02: detect the installed buildid", "04: fail loudly on mismatch"]
  },
  "questions": {
    "fog_or_ticket": {
      "type": "choice",
      "instructions": "Can this be stated as a precise, answerable question right now?",
      "criteria": {
        "ticket": "the question can be stated precisely now, even if the answer is not yet known",
        "fog": "the question cannot yet be stated precisely, and saying more would just restate the unease"
      }
    },
    "research_would_resolve": {
      "type": "noul",
      "instructions": "Would a research ticket establish enough to state this precisely, without needing to make the decision?"
    }
  }
}
```

## Caveats

- Two labels is the minimum useful `choice`. It works well because the decision is
  genuinely binary and the confidence will be high when it is clear.
- The `instructions` wording is load-bearing. "Can this be stated" must be there, or the
  model will answer "can this be solved", which is the question the skill explicitly says
  is the wrong one.
- `research_would_resolve` distinguishes the two kinds of fog: fog that a research ticket
  clears, and fog that needs grilling. That maps onto
  [use-cases/wayfinder-type](wayfinder-type.md).

## See also

[use-cases/wayfinder-type](wayfinder-type.md) · [use-cases/decision-ticket-optional](decision-ticket-optional.md) ·
[use-cases/frontier-priority](frontier-priority.md)
