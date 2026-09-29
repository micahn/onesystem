---
id: glossary-drift
title: Has the glossary drifted
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [noul]
status: candidate
human_review: optional
risk_when_wrong: low
skills: [domain-modeling, grill-with-docs]
trigger: "Code and CONTEXT.md disagree, and the repo policy is that the glossary wins, so the glossary needs correcting."
tags: [use-case, glossary]
---

# Has the glossary drifted

`daw/AGENTS.md` states a rule that is unusual enough to be worth encoding: **"when code and
glossary disagree, the glossary wins."** Not the code — the glossary. The glossary is the
intent, and drift means the code has departed from it.

Six repos keep a `CONTEXT.md` and `docs/adr/`: `breath`, `daw`, `worldgrab`, `theweather`,
`oma-bear`, `omarchy-calculator-plugin`.

## Payload

```json
{
  "state": {
    "glossary_term": "GapFill",
    "glossary_definition": "the automatic placement of a student into an unscheduled gap in a show lineup",
    "code_behaviour": "GapFill only triggers when the gap is at least two slots long and the student has no conflicts",
    "code_added_constraint": "minimum gap length of two",
    "adr_reference": "docs/adr/0002-gapfill-constraints.md"
  },
  "questions": {
    "drifted": {
      "type": "noul",
      "instructions": "Has the code diverged from what the domain glossary says this term means, in a way the glossary has not been updated to reflect?"
    },
    "glossary_stale": {
      "type": "noul",
      "instructions": "Is the glossary now the less accurate of the two, and would following it lead an implementer to build the wrong thing?"
    },
    "needs_adr": {
      "type": "noul",
      "instructions": "Is this a deliberate design decision that was made and never recorded, rather than an accidental divergence?"
    }
  }
}
```

## Caveats

- **The repo policy decides who wins, and it is not always the code.** `daw` says the
  glossary wins. Elsewhere the code wins. Put the policy in `state` or you will get the
  wrong recommendation.
- `needs_adr` is the valuable one. Drift is either a decision that was made and not
  written down, or a bug. Those need opposite responses, and the difference is invisible
  without asking.
- `domain-modeling` is the skill that fixes it, and `grill-with-docs` is the flow that
  fixes it while asking. This use case only tells you there is something to fix.

## See also

[use-cases/doc-done-criteria-clear](doc-done-criteria-clear.md) · [use-cases/research-claim-primary-source](research-claim-primary-source.md)
