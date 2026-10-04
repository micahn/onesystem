---
id: debug-seam-is-real
title: Does the seam exercise the real bug
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [noul]
status: candidate
human_review: optional
risk_when_wrong: high
skills: [diagnosing-bugs, tdd]
trigger: "A test seam is being chosen for a regression test. A seam that fakes the bug pattern produces a green suite and a live bug."
tags: [use-case, debug]
---

# Does the seam exercise the real bug

`diagnosing-bugs` L118: *"A correct seam is one where the test exercises the **real bug
pattern** ... gives false confidence."* That is the most quietly dangerous failure in
software testing, and `risk_when_wrong: high` here for that reason.

## Payload

```json
{
  "state": {
    "proposed_seam": "test the decoder's pure function dem_opcode(state, opcode) directly",
    "real_code_path": "cartridge.run -> dispatch -> dem_opcode",
    "seam_bypasses": ["the dispatch table lookup", "the operand fetch from the ROM bus"],
    "bug_manifests_in": "the dispatch table handing the fast path a swapped operand pair"
  },
  "questions": {
    "exercises_real_bug": {
      "type": "noul",
      "instructions": "Would a test written at this seam actually go red because of the real bug, rather than going green while the bug is still present?"
    },
    "bypasses_the_culprit": {
      "type": "noul",
      "instructions": "Does this seam bypass the code where the bug actually lives?"
    },
    "false_confidence": {
      "type": "noul",
      "instructions": "Would this seam produce a green suite that gives false confidence that the bug is fixed?"
    }
  }
}
```

## Caveats

- `bypasses_the_culprit` is the question to ask first and the one most likely to be true.
  A seam that skips the dispatch table cannot catch a dispatch-table bug, and that is
  obvious in hindsight and invisible while writing the test.
- `false_confidence` is the consequence stated plainly. It is redundant with the first
  question on purpose: redundancy in a safety check is free, and this is the check people
  skip because they are in a hurry and the test is already written.
- Include `bypasses` as an explicit list. Making the agent name what is skipped is what
  surfaces an omission you did not notice.

## See also

[use-cases/debug-red-signal-quality](debug-red-signal-quality.md) · [use-cases/debug-hypothesis-rank](debug-hypothesis-rank.md) ·
[use-cases/acceptance-criteria-checkable](acceptance-criteria-checkable.md)
