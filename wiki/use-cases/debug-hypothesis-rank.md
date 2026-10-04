---
id: debug-hypothesis-rank
title: Rank the hypotheses
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [score]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [diagnosing-bugs]
trigger: "Three to five candidate root causes have been generated and must be ranked before any is tested. The skill explicitly permits proceeding on the ranking when the user is AFK."
tags: [use-case, debug]
---

# Rank the hypotheses

The best-targeted use case in the wiki, because the skill *explicitly authorises* it.
`diagnosing-bugs` L90-98:

> Generate **3–5 ranked hypotheses** before testing any of them ... **Show the ranked list
> to the user before testing.** ... Don't block on it; proceed with your ranking if the
> user is AFK.

That last clause is a sanctioned autonomous decision. Ranking hypotheses is a `score` per
hypothesis in one call.

## Payload

```json
{
  "state": {
    "bug": "DEM decoding is inverted for opcode 0x1A only in the fast path",
    "hypotheses": [
      {"id": "H1", "text": "the fast path and the reference path disagree on the Y bit's bit position"},
      {"id": "H2", "text": "opcode 0x1A is missing from the fast path's dispatch table and falls through"},
      {"id": "H3", "text": "a 16-bit shift overflows when the register index is 15"},
      {"id": "H4", "text": "the operand order is swapped only when an immediate follows"},
      {"id": "H5", "text": "a test fixture uses a ROM whose header is corrupt"}
    ],
    "evidence_so_far": "the slow path decodes 0x1A correctly; only --fast differs"
  },
  "questions": {
    "H1": { "type": "score", "instructions": "How likely is this hypothesis to be the cause, given the evidence so far?",
            "criteria": ["implausible", "possible", "likely", "most likely given the evidence"] },
    "H2": { "type": "score", "instructions": "How likely is this hypothesis to be the cause, given the evidence so far?",
            "criteria": ["implausible", "possible", "likely", "most likely given the evidence"] },
    "H3": { "type": "score", "instructions": "How likely is this hypothesis to be the cause, given the evidence so far?",
            "criteria": ["implausible", "possible", "likely", "most likely given the evidence"] },
    "H4": { "type": "score", "instructions": "How likely is this hypothesis to be the cause, given the evidence so far?",
            "criteria": ["implausible", "possible", "likely", "most likely given the evidence"] },
    "H5": { "type": "score", "instructions": "How likely is this hypothesis to be the cause, given the evidence so far?",
            "criteria": ["implausible", "possible", "likely", "most likely given the evidence"] }
  }
}
```

## Caveats

- **Repeat the question per hypothesis.** Five question ids, one forward pass. A `choice`
  over hypothesis ids would force the model to allocate a probability mass budget across
  mutually exclusive options, which is not what you want — you want five independent
  likelihoods.
- `evidence_so_far` is the whole game. *"only `--fast` differs"* should push you toward H1
  and H2 and away from H5. Without it you are asking the model to rank hypotheses using
  only the bug description, which is priors, not evidence.
- The rubric is doing the work. `"most likely given the evidence"` is different from
  `"most likely"` and the difference is the entire use case.
- **Show the ranking to the user before testing.** The skill requires it and this use case
  does not remove that step; it makes the ranking better while you are still there.

## See also

[use-cases/debug-red-signal-quality](debug-red-signal-quality.md) · [use-cases/debug-seam-is-real](debug-seam-is-real.md) ·
[patterns/multi-question-batches](../patterns/multi-question-batches.md)
