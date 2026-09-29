---
id: debug-is-real-bug
title: Real bug or misunderstanding
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [diagnosing-bugs, triage]
trigger: "Deciding whether a report is a defect, a misconfiguration, a misunderstanding of intended behaviour, or already handled."
tags: [use-case, debug]
---

# Real bug or misunderstanding

Before spending a debugging session, establish that there is a bug. Four-way `choice`,
and the fourth option is the one that saves the most time.

## Payload

```json
{
  "state": {
    "report": "the overlay does not appear when I press F9",
    "reproduction": "confirmed on two machines",
    "config": "wayland, hyprland, omarchy-shell 0.9",
    "recent_changes": "overlay config was refactored three commits ago"
  },
  "questions": {
    "verdict": {
      "type": "choice",
      "instructions": "What is actually going on here?",
      "criteria": {
        "real_bug": "the code intends to do this and does not",
        "misconfiguration": "the code is correct and the environment or config is wrong",
        "misunderstanding": "the behaviour is intended and the reporter expected something else",
        "already_handled": "a different code path already covers this case"
      }
    },
    "works_elsewhere": {
      "type": "noul",
      "instructions": "Does the same action work correctly in another environment or configuration, which would point at config rather than code?"
    },
    "regression": {
      "type": "noul",
      "instructions": "Is this a regression, meaning it worked at some earlier point and a specific change broke it?"
    }
  }
}
```

## Caveats

- `already_handled` is the highest-value label and the one people delete. If a second code
  path already covers the case, the whole session is wasted.
- `regression` narrows the search enormously — it turns "find the bug" into "bisect these
  three commits", which is mechanical.
- This is a triage question wearing a debugging hat. It pairs naturally with
  [use-cases/triage-claim-holds](triage-claim-holds.md) and they could share one call when triaging a bug
  report.

## See also

[use-cases/triage-claim-holds](triage-claim-holds.md) · [use-cases/debug-red-signal-quality](debug-red-signal-quality.md) ·
[use-cases/triage-state](triage-state.md)
