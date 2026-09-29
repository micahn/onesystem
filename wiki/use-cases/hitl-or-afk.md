---
id: hitl-or-afk
title: HITL or AFK
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: required
risk_when_wrong: high
skills: [wayfinder, grilling]
trigger: "Deciding whether a ticket can be resolved by the agent alone. Getting this wrong lets an agent stand in for the human, which the skill calls broken."
tags: [use-case, hitl]
---

# HITL or AFK

The highest-consequence use case in the wiki, and the one with the clearest prohibition
behind it. `wayfinder` L75:

> Every ticket is either **HITL** (human in the loop) or **AFK**, driven by the agent
> alone. A HITL ticket only resolves through that live exchange; the agent never stands in
> for the human's side of it (a grilling agent that answers its own questions has broken
> this).

## Payload

```json
{
  "state": {
    "ticket": "decide whether the sync format should keep the legacy v1 field",
    "type": "grilling",
    "open_questions": [
      "how much do we care about syncing with v1 clients",
      "what is the migration story for existing users"
    ],
    "resolution_requires": "a human deciding what they care about"
  },
  "questions": {
    "mode": {
      "type": "choice",
      "instructions": "Does resolving this ticket require a human in the loop, or can the agent work it alone?",
      "criteria": {
        "HITL": "resolution depends on a human's priorities, taste, or authority, and needs a live exchange",
        "AFK": "resolution is determined by evidence or a mechanical rule the agent can apply alone"
      }
    },
    "answerable_by_facts": {
      "type": "noul",
      "instructions": "Can this be resolved by gathering and checking evidence, with no human needing to express a preference?"
    },
    "would_substitute_for_human": {
      "type": "noul",
      "instructions": "Would the agent answering this on its own be standing in for the human's side of a conversation that is supposed to be live?"
    }
  }
}
```

## Caveats

- `would_substitute_for_human` is the direct encoding of the skill's prohibition. Read it
  first, and treat a `true` as a hard stop regardless of what `mode` said.
- **`risk_when_wrong: high`.** A `false` here means a grilling agent answers its own
  questions, and the skill's words for that are *"has broken this"*. There is no partial
  credit.
- Even at `HITL`, the useful output is *"this is HITL, here are the open questions"* — not
  an answer. `answerable_by_facts` gives you the AFK case cleanly.

## See also

[use-cases/wayfinder-type](wayfinder-type.md) · [the prohibition in context](../patterns/wiring-into-skills.md#2.-do-not-let-laya-answer-a
hitl-grilling-ticket)
