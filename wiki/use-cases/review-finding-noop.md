---
id: review-finding-noop
title: Is this finding a no-op
kind: use-case
surface: [mcp]
tools: [predict]
# Reachable as written. julia needs the state flattened to a string.
engines: [laya, rizzo]
question_types: [noul]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [code-review, writing-for-agents]
trigger: "Testing a finding against the no-op rule: does it change behaviour versus the default, settled by running the thing rather than debating it."
tags: [use-case, review]
---

# Is this finding a no-op

`writing-for-agents` L81 states the test better than it has any right to:

> The test (does it change behaviour versus the default?) is model-relative, not
> reader-relative: two people disagreeing about a no-op disagree about the default, and
> settle it by running the document, not by debate.

A finding that changes nothing versus the default is not a finding. The engine is a cheap first
filter; running the thing is the real test.

## Payload

```json
{
  "state": {
    "finding": "this README should mention the --json flag",
    "current_default": "the README does not mention --json; the flag exists and is undocumented",
    "finding_proposes": "add one line to the README",
    "who_reads_this": "a new contributor looking for the flag"
  },
  "questions": {
    "is_noop": {
      "type": "noul",
      "instructions": "Would acting on this finding change behaviour or knowledge for its reader, versus leaving the current default in place unchanged?"
    },
    "observable": {
      "type": "noul",
      "instructions": "Is the difference observable and checkable by running or using the thing, rather than only by agreeing about it?"
    },
    "speculative_reader": {
      "type": "noul",
      "instructions": "Is this finding about a reader or situation that does not actually exist in practice?"
    }
  }
}
```

## Caveats

- `observable` is the load-bearing question. It encodes *"settle it by running the
  document, not by debate"*, which is the part that is easy to lose.
- `speculative_reader` is the second half of "model-relative": findings about imaginary
  readers are the most common form of this noise.
- The honest workflow is Laya filters, a human runs. Anything `is_noop` says is `true` for
  should be dropped *after* a glance, not trusted as final.

## See also

[use-cases/review-finding-kind](review-finding-kind.md) · [use-cases/doc-done-criteria-clear](doc-done-criteria-clear.md)
