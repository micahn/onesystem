---
id: frontier-priority
title: Which frontier ticket next
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [score, choice]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [wayfinder, implement, triage]
trigger: "Several tickets are unblocked and unclaimed, and the next one has to be picked."
tags: [use-case, frontier]
---

# Which frontier ticket next

`wayfinder` L69 defines the frontier as *"the open, unblocked, unclaimed children, the edge
of the known"*, and L120: *"A ticket is optional: without one, you pick the next decision,
not the user."* So when no ticket is nominated, choosing the next one is the agent's job
and not a human's.

`implement` and `triage` both lean on the same idea — work the frontier.

## Payload

Pass the candidate tickets as a **list in `state`**, in whatever order you found them:

```json
{
  "state": {
    "candidates": [
      {"id": "01", "title": "extract the config loader", "blocks": ["04", "05"], "size": "S"},
      {"id": "02", "title": "add a --json flag to the CLI", "blocks": [], "size": "S"},
      {"id": "03", "title": "decide the plugin ABI for v2", "blocks": ["06"], "size": "L"},
      {"id": "04", "title": "add a /health endpoint", "blocks": [], "size": "M"},
      {"id": "05", "title": "validate config on startup", "blocks": [], "size": "M"}
    ],
    "goal": "make the first release usable end to end"
  },
  "questions": {
    "next": {
      "type": "score",
      "instructions": "How much decision value does working this ticket now unlock?",
      "criteria": [
        "none: unblocks nothing and resolves nothing",
        "low: incremental progress on one area",
        "high: unblocks several other tickets or resolves a real unknown",
        "critical: nothing else can proceed until this is answered"
      ]
    },
    "cheap_first": {
      "type": "noul",
      "instructions": "Is this the smallest ticket that unblocks at least one other ticket?"
    }
  }
}
```

## Caveats

- **Do not use a `choice` here.** A `choice` needs discrete labels; you have an open set
  of candidates whose size changes. `score` is the right type, and you read the argmax
  yourself by running one question per candidate in a single call.
- Actually: send **one `score` question per candidate in one call**, all named
  `next_01`, `next_02`, … That is laya's `predict_batch` pattern, and it carries a measured
  caveat: below roughly 50 states the throughput win does not justify restructuring
  code. See [the models page](../reference/models.md).
- `cheap_first` encodes the tracer-bullet instinct: smallest thing that unblocks something.
  It is a `noul` so it is independent of the `score`, and disagreement between them is
  informative.
- The model has not read the tickets. Titles and the `blocks` graph are the state. If you
  want it to weigh risk, include sizes.

## See also

[use-cases/fog-or-ticket](fog-or-ticket.md) · [use-cases/hitl-or-afk](hitl-or-afk.md) ·
[use-cases/blocking-edges-genuine](blocking-edges-genuine.md)
