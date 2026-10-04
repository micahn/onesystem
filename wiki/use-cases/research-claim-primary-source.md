---
id: research-claim-primary-source
title: Is the claim primary-sourced
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [noul]
status: candidate
human_review: optional
risk_when_wrong: medium
skills: [research]
trigger: "A claim in a research note is being checked for whether it is traced to the primary source that owns it."
tags: [use-case, research]
---

# Is the claim primary-sourced

`research` L10-11:

> Investigate the question against **primary sources** (official docs, source code, specs,
> first-party APIs), not a secondary write-up of them. Follow every claim back to the source
> that owns it. ... Write the findings to a single Markdown file, citing each claim's source.

There is no acceptance gate on this today. This is a candidate one.

## Payload

```json
{
  "state": {
    "claim": "the zlib PNG spec requires IDAT chunks to be consecutive",
    "cited_source": "a 2021 blog post about optimising PNG encoders",
    "original_source_exists": "the PNG specification, section 3.4.3"
  },
  "questions": {
    "primary_sourced": {
      "type": "noul",
      "instructions": "Is this claim traced back to the primary source that owns the specification, rather than to someone's write-up of it?"
    },
    "authority": {
      "type": "noul",
      "instructions": "Is the cited source one that owns or defines the thing being claimed, rather than a secondary source describing it?"
    },
    "verifiable": {
      "type": "noul",
      "instructions": "Could a reader follow the citation and land on the exact place that states this?"
    }
  }
}
```

## Caveats

- `authority` is the substantive one. A blog post can be perfectly accurate and still be
  the wrong citation, because it will eventually be wrong in a way the spec is not.
- `verifiable` catches the very common failure of a link to a document's homepage rather
  than the section. Cheap to check, frequently wrong.
- This gates a *citation*, not a *fact*. Laya cannot tell you the spec says something
  different — it has not read the spec. It can tell you that you cited a blog.

## See also

[use-cases/glossary-drift](glossary-drift.md) · [use-cases/triage-claim-holds](triage-claim-holds.md) ·
[use-cases/untrusted-content-injection](untrusted-content-injection.md)
