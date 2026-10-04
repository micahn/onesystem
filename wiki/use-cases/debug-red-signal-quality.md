---
id: debug-red-signal-quality
title: Is this a trustworthy red signal
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [score, noul]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [diagnosing-bugs, tdd]
trigger: "A candidate reproduction command exists and is being judged against red-capable, deterministic, fast, agent-runnable."
tags: [use-case, debug]
---

# Is this a trustworthy red signal

`diagnosing-bugs` L20:

> If you have a **tight** pass/fail signal for the bug (one that goes red on *this* bug),
> you will find the cause ... If you don't have one, no amount of staring at code will save
> you.

L61-64 gives a four-point checklist: **red-capable**, **deterministic**, **fast**,
**agent-runnable**. Four binary properties — four `noul` questions, one pass.

L66 is the enforcement: *"If you catch yourself reading code to build a theory before this
command exists, stop."*

## Payload

```json
{
  "state": {
    "command": "node tests/test.mjs",
    "goes_red_on_this_bug": true,
    "run_count_to_check": 20,
    "flaky_runs": 0,
    "seconds": 1.4,
    "needs_manual_setup": false,
    "needs_human_to_interpret_output": false
  },
  "questions": {
    "red_capable": {
      "type": "noul",
      "instructions": "Does this command go red specifically because of this bug, rather than passing while the bug is present?"
    },
    "deterministic": {
      "type": "noul",
      "instructions": "Does this command give the same result every time it is run, with no flakiness, ordering dependence, or reliance on wall-clock time or network?"
    },
    "fast": {
      "type": "noul",
      "instructions": "Is this command fast enough to run in a tight loop, ideally a few seconds?"
    },
    "agent_runnable": {
      "type": "noul",
      "instructions": "Can an agent run this command unattended and tell from its output alone whether it passed or failed, without a human interpreting the result?"
    }
  }
}
```

## Caveats

- **Put the measurements in `state`.** `flaky_runs: 0`, `seconds: 1.4`,
  `run_count_to_check: 20`. Laya cannot run the command 20 times for you; if you omit the
  flakiness count it is grading a claim.
- Four `noul` questions, no `choice`. A signal is either trustworthy or it is not, and the
  output you want is a checklist, not a ranking.
- Any `false` is a **stop**, per L66. Do not proceed to Phase 2 on a signal that is fast
  but not red-capable — that is the specific way this skill's discipline gets skipped.
- The obvious companion is [use-cases/debug-seam-is-real](debug-seam-is-real.md): a red-capable signal built on
  a fake seam is a green suite and a live bug.

## See also

[use-cases/debug-hypothesis-rank](debug-hypothesis-rank.md) · [use-cases/debug-seam-is-real](debug-seam-is-real.md) ·
[use-cases/acceptance-criteria-checkable](acceptance-criteria-checkable.md)
