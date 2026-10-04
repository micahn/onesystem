---
id: triage-state
title: Which triage state
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: required
risk_when_wrong: medium
skills: [triage]
trigger: "An unlabeled or mislabeled issue needs one state role from the repo's own triage vocabulary."
tags: [use-case, triage]
---

# Which triage state

The richest target in `matts-skills`, and the one most likely to be got wrong by reaching
for the wrong tool.

**Do not use ``laya_preset`(preset="triage")`.** That preset is a customer-support desk
classifier — `refund`, `billing_question`, `churn_risk`, `frustration`. Its vocabulary has
nothing to do with software issues. Hand-write the `choice` with the repo's own labels
instead; that is the entire advantage of a custom-rubric classifier.

The vocabulary below is lifted verbatim from
`matts-skills/skills/engineering/triage/SKILL.md` L28-37.

## Payload

```json
{
  "state": {
    "title": "search returns wrong results when the query has two spaces",
    "body": "Steps to reproduce, expected vs actual, one paragraph each.",
    "has_reproduction": true,
    "has_expected_behaviour": true,
    "affects_users": true
  },
  "questions": {
    "state": {
      "type": "choice",
      "instructions": "Which triage state should this issue be in?",
      "criteria": {
        "needs-triage": "nobody has looked at it yet and it is not obviously actionable",
        "needs-info": "the claim cannot be verified from what is written, or a required detail is missing",
        "ready-for-agent": "clearly specified and verifiable, so an agent can implement it unaided",
        "ready-for-human": "needs a design, product or ownership decision that only a person can make",
        "wontfix": "already implemented, redundant, previously rejected, or out of scope"
      }
    },
    "sufficient_detail": {
      "type": "noul",
      "instructions": "Is there enough detail here to verify the claim against the codebase without asking the reporter anything?"
    }
  }
}
```

## Caveats

- **Five labels.** If your repo's
  `triage-labels.md` has more roles you go past it, which Laya warns about at load — see
  [reference/guardrails](../reference/guardrails.md#the-`choice:11+`-temperature-clamp). In practice that is a soft
  concern: 34 labels measured *better* than a hand-picked 10 on a well-written `state`.
- `sufficient_detail` is the `needs-info` signal the skill talks about at L74. It is often
  more reliable than the five-way choice, because it is a yes/no question.
- One category role and one state role per issue. Ask [use-cases/triage-category](triage-category.md) in the
  same call.
- `human_review: required`. The skill's instruction is *"Recommend ... Wait for
  direction."* This is the recommendation; the wait is still the skill's job.

## See also

[use-cases/triage-category](triage-category.md) · [use-cases/triage-claim-holds](triage-claim-holds.md) ·
[use-cases/triage-unusual-transition](triage-unusual-transition.md) · [patterns/wiring-into-skills](../patterns/wiring-into-skills.md)
