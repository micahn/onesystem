---
id: triage-category
title: Bug or enhancement
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [choice]
status: candidate
human_review: required
risk_when_wrong: low
skills: [triage]
trigger: "An issue has a state role and still needs exactly one category role."
tags: [use-case, triage]
---

# Bug or enhancement

The second label every triaged issue needs. `triage` L27-29 defines `bug` and
`enhancement`; your repo's `docs/agents/triage-labels.md` is the file that overrides them.

## Payload

```json
{
  "state": {
    "title": "crashes when the config file has a trailing comma",
    "body": "Expected: config loads. Actual: unhandled exception.",
    "labels_applied": []
  },
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "Which category role does this issue belong to?",
      "criteria": {
        "bug": "existing intended behaviour does not work, or something breaks",
        "enhancement": "existing behaviour works and this asks for something new or different",
        "question": "the reporter is asking whether something is supported rather than reporting a problem",
        "support": "needs help using something that already works"
      }
    },
    "is_regression": {
      "type": "noul",
      "instructions": "Did this work correctly at some earlier point and has since stopped working?"
    }
  }
}
```

## Caveats

- Four labels. `question` and `support` are the ones people forget,
  and they are exactly the ones that get filed as bugs.
- `is_regression` is more useful than it looks: regressions are cheap to confirm and
  expensive to mis-file, and it is a clean yes/no.
- **Use your repo's vocabulary.** The glosses are the load-bearing part. If your labels
  are `defect`/`chore`/`question`, change the labels *and* the descriptions together.

## See also

[use-cases/triage-state](triage-state.md) · [use-cases/triage-already-implemented](triage-already-implemented.md)
