---
id: decision-ticket-optional
title: Does this deserve a ticket
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [noul]
status: candidate
human_review: optional
risk_when_wrong: low
skills: [wayfinder]
trigger: "A decision has come up that might not be worth its own ticket; the default is to decide it inline."
tags: [use-case, decision]
---

# Does this deserve a ticket

`wayfinder` L120: *"A ticket is **optional**: without one, you pick the next decision, not
the user."* The default is to decide something inline. This use case is the check on the
exception.

Over-ticketing is a real cost: a decision that deserved one sentence of conversation gets
a file, a status, and a frontier slot.

## Payload

```json
{
  "state": {
    "decision": "name the new module config_loader.rs or config.rs",
    "who_is_affected": "one contributor",
    "is_it_reversible": true,
    "reversibility": "a single git mv",
    "would_come_up_again": false
  },
  "questions": {
    "deserves_ticket": {
      "type": "noul",
      "instructions": "Is this decision significant enough to deserve its own tracked ticket rather than being made inline?"
    },
    "hard_to_reverse": {
      "type": "noul",
      "instructions": "Would this decision be expensive or annoying to reverse later, or affect anyone beyond the person making it?"
    },
    "recurs": {
      "type": "noul",
      "instructions": "Is this the same class of decision that will come up again as the work continues?"
    }
  }
}
```

## Caveats

- Default is `false`. A `true` needs at least two of the three signals, which is a good
  reason to ask all three separately rather than as one question.
- `recurs` is the one people skip, and it is the one that matters most: a decision you
  will make six more times is worth writing down even though this instance is trivial.
- `risk_when_wrong: low` and `human_review: optional` — the cost of a false positive is
  one small ticket.

## See also

[use-cases/fog-or-ticket](fog-or-ticket.md) · [use-cases/wayfinder-type](wayfinder-type.md) ·
[use-cases/spec-readiness](spec-readiness.md)
