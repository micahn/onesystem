---
id: triage-unusual-transition
title: Is this transition unusual
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [noul]
status: candidate
human_review: required
risk_when_wrong: low
skills: [triage]
trigger: "A proposed state transition skips the normal path, and the skill says to flag and ask before proceeding."
tags: [use-case, triage]
---

# Is this transition unusual

`triage` L45: *"flag transitions that look unusual and ask before proceeding."* L41 is
sharper: *"If state roles conflict, flag it and ask the maintainer before doing anything
else."*

A transition is the input here, not the issue.

## Payload

```json
{
  "state": {
    "from_state": "needs-triage",
    "to_state": "wontfix",
    "issue": "add dark mode",
    "maintainer_note": "closing, out of scope for this milestone"
  },
  "questions": {
    "unusual": {
      "type": "noul",
      "instructions": "Is this state transition unusual enough that a maintainer should explicitly confirm it rather than have it applied silently?"
    },
    "conflicting_roles": {
      "type": "noul",
      "instructions": "Does this issue carry more than one state role, or a state role that conflicts with its category role?"
    },
    "skipped_verification": {
      "type": "noul",
      "instructions": "Does this transition skip the verification step, moving straight from untriaged to a terminal state?"
    }
  }
}
```

## Caveats

- Three `noul` questions, no `choice` — the decision is binary (ask or do not ask), so
  there is nothing to rank.
- `skipped_verification` catches the genuinely dangerous case: `needs-triage` straight to
  `wontfix` means nobody ever checked whether the request was already implemented. Pair it
  with [use-cases/triage-already-implemented](triage-already-implemented.md).
- `risk_when_wrong: low` because the output is "ask a human", which is cheap. The failure
  mode is the opposite error — staying silent on a transition that needed confirmation.

## See also

[use-cases/triage-state](triage-state.md) · [use-cases/triage-already-implemented](triage-already-implemented.md)
