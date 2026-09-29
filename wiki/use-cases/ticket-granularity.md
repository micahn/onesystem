---
id: ticket-granularity
title: Is the ticket granularity right
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: required
risk_when_wrong: medium
skills: [to-tickets]
trigger: "A ticket breakdown has been produced and is being reviewed before the user approves it."
tags: [use-case, ticket]
---

# Is the ticket granularity right

`to-tickets` SKILL.md L52-56 asks the user three questions after breaking work down, and
the first is *"Does the granularity feel right? (too coarse / too fine)"*. That is a
perfect three-label `choice`, and it is asked on every batch of tickets.

## Payload

```json
{
  "state": {
    "ticket": "Migrate the ticket tracker from markdown files to GitHub Issues",
    "files_touched_estimate": 14,
    "has_single_verification": true,
    "can_be_reverted_in_one_step": true
  },
  "questions": {
    "granularity": {
      "type": "choice",
      "instructions": "Is this ticket sized correctly as one tracer-bullet slice of work?",
      "criteria": {
        "right": "one focused change with a clear way to verify it",
        "too_coarse": "spans several concerns and could fail in more than one place",
        "too_fine": "a single trivial step not worth tracking on its own"
      }
    },
    "is_atomic": {
      "type": "noul",
      "instructions": "Can this ticket be completed and verified without waiting on another ticket that is not already done?"
    }
  }
}
```

## Caveats

- `is_atomic` overlaps [use-cases/blocking-edges-genuine](blocking-edges-genuine.md). Ask both in one call; it is
  the same forward pass.
- Tracer-bullet is the right frame: a ticket that cannot be *verified* on its own is too
  coarse, regardless of how small the diff is.
- Still `human_review: required` — the skill explicitly iterates with the user until they
  approve the breakdown. This informs the conversation; it does not close it.

## See also

[use-cases/blocking-edges-genuine](blocking-edges-genuine.md) · [patterns/multi-question-batches](../patterns/multi-question-batches.md)
