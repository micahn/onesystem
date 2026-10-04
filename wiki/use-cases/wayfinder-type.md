---
id: wayfinder-type
title: Which wayfinder type
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: required
risk_when_wrong: medium
skills: [wayfinder]
trigger: "A decision ticket is being authored and needs its wayfinder:<type> label."
tags: [use-case, wayfinder]
---

# Which wayfinder type

`wayfinder` L65: *"Each ticket carries a `wayfinder:<type>` label, one of `research`,
`prototype`, `grilling`, `task`."* Four labels, lifted verbatim.

## Payload

```json
{
  "state": {
    "question": "should the plugin ABI be a flat C struct or a versioned vtable?",
    "what_is_known": "the current struct is 6 fields and two consumers",
    "what_is_unknown": "whether third-party mods will need to be supported"
  },
  "questions": {
    "type": {
      "type": "choice",
      "instructions": "Which wayfinder type resolves this decision?",
      "criteria": {
        "research": "the answer is out there and can be gathered from primary sources",
        "prototype": "the answer only appears once something tangible is built and tried",
        "grilling": "the answer depends on human priorities and trade-offs, not on facts",
        "task": "there is no decision to make, the work is simply known and executable"
      }
    },
    "is_precedence_decision": {
      "type": "noul",
      "instructions": "Is this really a decision, or has it already effectively been made by whoever wrote the first implementation?"
    }
  }
}
```

## Caveats

- Four labels. The glosses are what make this work — "the answer only appears
  once something tangible is built" is the whole distinction between `prototype` and
  `grilling`, and a lazy gloss loses it.
- `is_precedence_decision` catches a real failure mode: a "decision" that was settled by
  accident by whoever wrote the first version. Those want `task` or an ADR, not a
  decision ticket.
- **`grilling` means HITL.** Do not let anything answer a grilling ticket but a human — see
  [use-cases/hitl-or-afk](hitl-or-afk.md).

## See also

[use-cases/hitl-or-afk](hitl-or-afk.md) · [use-cases/fog-or-ticket](fog-or-ticket.md) ·
[use-cases/decision-ticket-optional](decision-ticket-optional.md)
