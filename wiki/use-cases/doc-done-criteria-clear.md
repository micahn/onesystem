---
id: doc-done-criteria-clear
title: Can an agent tell done from not-done
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [noul, score]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [writing-for-agents, to-spec, writing-for-agents]
trigger: "A document has been written for an agent to follow, and the bound it states needs to be checkable rather than vague."
tags: [use-case, doc]
---

# Can an agent tell done from not-done

`writing-for-agents` is unusually precise about why vague bounds are dangerous. L49:

> A vague bound ("understanding reached") invites **premature completion** ... **Clarity**:
> can the agent tell done from not-done?

Premature completion is the expensive failure: an agent that stops early produces something
that looks finished.

## Payload

```json
{
  "state": {
    "document": "docs/agents/issue-tracker.md",
    "stated_bound": "the agent should understand how the tracker works before making changes",
    "has_explicit_checklist": false,
    "has_command_examples": true,
    "has_failure_modes": false
  },
  "questions": {
    "done_is_clear": {
      "type": "noul",
      "instructions": "Can an agent reading this document tell, without asking a human, whether it has finished reading and understood it?"
    },
    "premature_completion": {
      "type": "noul",
      "instructions": "Could an agent plausibly decide it is done while having missed something the document actually required?"
    },
    "vague_bound": {
      "type": "noul",
      "instructions": "Is the completion bound stated in words like 'understand', 'know', 'familiar with', or 'grasp', rather than as something checkable?"
    }
  }
}
```

## Caveats

- `vague_bound` is checkable by grep. `understand|know|familiar|grasp|appreciate` in a
  completion sentence is a reliable signal, and putting the actual sentence in `state`
  lets Laya judge it in context rather than by keyword alone.
- `premature_completion` is the consequence and is the one to read first. It reframes the
  question from "is this clear?" to "what would a plausible agent get wrong?".
- Pairs with [use-cases/acceptance-criteria-checkable](acceptance-criteria-checkable.md), which grades the criteria in a
  spec rather than the completion bound in a document. Same underlying concern, different
  artifact.

## See also

[use-cases/acceptance-criteria-checkable](acceptance-criteria-checkable.md) · [use-cases/spec-readiness](spec-readiness.md) ·
[use-cases/glossary-drift](glossary-drift.md)
