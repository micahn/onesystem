---
id: prototype-branch
title: Logic branch or UI branch
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: optional
risk_when_wrong: low
skills: [prototype]
trigger: "The prototype question is ambiguous and the user is unreachable, so the branch matching surrounding code has to be chosen and the assumption stated."
tags: [use-case, prototype]
---

# Logic branch or UI branch

`prototype` L17, with a default already written in:

> If the question is genuinely ambiguous and the user isn't reachable, default to whichever
> branch better matches the surrounding code (a backend module → logic; a page or component
> → UI) and state the assumption at the top of the prototype.

That is a `choice` between exactly two branches, and the skill already tells you the
tie-breaker. Laya applies the tie-breaker to the specific situation.

## Payload

```json
{
  "state": {
    "question": "does gap-filling the lineup feel confusing or helpful",
    "location": "the schedule editor page",
    "surrounding_code": "a Svelte page component with a sibling list view",
    "user_reachable": false,
    "ambiguous": true
  },
  "questions": {
    "branch": {
      "type": "choice",
      "instructions": "Which branch should this throwaway prototype explore?",
      "criteria": {
        "logic": "the surrounding code is backend or domain logic, so a logic prototype fits",
        "ui": "the surrounding code is a page or component, so a UI prototype fits",
        "ask_the_user": "the user is reachable, so ask rather than assume"
      }
    },
    "ambiguous": {
      "type": "noul",
      "instructions": "Is the design question genuinely ambiguous, rather than having one obvious reading?"
    }
  }
}
```

## Caveats

- `ask_the_user` is a **label, not a fallback**. If the user is reachable, that is the
  right answer and the prototype should not be built yet. The skill's default only applies
  when they are not.
- `ambiguous` gates the whole thing. The skill's default is for genuinely ambiguous
  questions; a question with one obvious reading does not need a prototype branch debate.
- Whatever comes back, the skill requires stating the assumption at the top of the
  prototype (L17) and capturing the verdict and the question it settled (L26). Laya picks
  the branch; it does not discharge either of those.

## See also

[use-cases/deepening-candidate-rank](deepening-candidate-rank.md) · [use-cases/skill-boundary-choice](skill-boundary-choice.md)
