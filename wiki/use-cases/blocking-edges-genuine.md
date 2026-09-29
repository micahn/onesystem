---
id: blocking-edges-genuine
title: Are blocking edges real
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [noul]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [to-tickets, wayfinder]
trigger: "Blocking edges have been declared between tickets and are about to define the work order."
tags: [use-case, blocking]
---

# Are blocking edges real

`to-tickets` L54: *"Are the blocking edges correct: does each ticket only depend on tickets
that genuinely gate it?"* Spurious edges are worse than missing ones — they serialise work
that could have run in parallel and quietly stall a frontier.

## Payload

```json
{
  "state": {
    "blocked": "Add a /health endpoint to the server",
    "blocker": "Extract the config loader into its own module",
    "reason_given": "the health endpoint needs validated config"
  },
  "questions": {
    "genuine_gate": {
      "type": "noul",
      "instructions": "Does the blocker genuinely prevent the blocked ticket from being completed and verified, or is it merely a code-style preference or a convenience?"
    },
    "would_ship_without": {
      "type": "noul",
      "instructions": "Could the blocked ticket be completed and verified on its own, with the blocker left for later?"
    }
  }
}
```

## Caveats

- Two `noul` questions that pull against each other on purpose. A genuine gate answers
  `true` to the first and `false` to the second; disagreement is the signal to ask a human.
- `would_ship_without` is the sharper question. "Do we prefer this order?" is almost always
  yes; "Can we verify without it?" is usually no.
- Laya has not read either ticket. Give it both titles and the stated reason, or you are
  grading your own summary.

## See also

[use-cases/ticket-granularity](ticket-granularity.md) · [use-cases/frontier-priority](frontier-priority.md)
