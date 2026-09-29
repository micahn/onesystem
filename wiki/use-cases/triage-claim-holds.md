---
id: triage-claim-holds
title: Does the claim hold up
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: required
risk_when_wrong: medium
skills: [triage]
trigger: "Before grilling an issue, the claim in it is being checked against the codebase."
tags: [use-case, triage]
---

# Does the claim hold up

`triage` L74: *"Verify the claim. Before any grilling, check that the claim holds up ...
Report what happened: confirmed (with code path), failed, or insufficient detail (a strong
`needs-info` signal)."*

That is a three-way outcome, which makes it a `choice` with three labels.

## Payload

```json
{
  "state": {
    "title": "DEM decoding is inverted for region 0x1A",
    "body": "Claims the Y bit is flipped for that opcode.",
    "code_path_examined": "src/cartridge/decode.c, opcode handler table",
    "tests_examined": "test/decode.test.ts",
    "test_result": "the existing test asserts the current behaviour and passes"
  },
  "questions": {
    "verdict": {
      "type": "choice",
      "instructions": "What happened when the claim was checked against the codebase?",
      "criteria": {
        "confirmed": "the code path exists and the claim holds against it",
        "failed": "the code does the claimed thing already, or does something else entirely",
        "insufficient_detail": "there is not enough information to check the claim either way"
      }
    },
    "is_hallucinated": {
      "type": "noul",
      "instructions": "Does the claim describe a code path, symbol or configuration key that does not exist in this repository?"
    }
  }
}
```

## Caveats

- **You must supply the evidence.** Laya has not opened the code. If `state` does not
  contain what you found, you are grading a hallucinated summary and the answer will be
  confidently wrong. This is the use case most vulnerable to the failure mode in
  [reference/guardrails](../reference/guardrails.md).
- `insufficient_detail` is the valuable label, because it is the one that routes to
  `needs-info` instead of wasting a grilling session.
- `is_hallucinated` is a strong separate signal — an issue naming a symbol that does not
  exist is worth catching before anything else.

## See also

[use-cases/triage-state](triage-state.md) · [use-cases/triage-already-implemented](triage-already-implemented.md) ·
[use-cases/debug-is-real-bug](debug-is-real-bug.md)
